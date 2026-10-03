/* ---------------------------------------------------------------
   Sync: keeps this browser's copy of the tickets in step with
   tickets.json in a private GitHub repository, so the help station
   and every staff computer see the same queue.

   How it works
   - The app keeps working on its local copy, so it stays instant and
     keeps working when the Wi-Fi drops.
   - This file remembers the last version it and GitHub agreed on (the
     "base"). To sync, it fetches GitHub's current version and merges
     ticket by ticket, field by field: whichever side changed a field
     since the base wins; if both did, this device's change wins.
     Notes are never lost — both sides' notes are kept.
   - Every write carries the version it was based on, so if another
     device saved in between, GitHub refuses it and we merge again.
   - Offline, changes wait in the local copy and go up on the next try.

   The file is written one ticket per line, so GitHub's history reads
   as a clean log of what changed.
   --------------------------------------------------------------- */

const Sync = (function () {
  const ROLE = document.documentElement.dataset.role === 'station' ? 'station' : 'desk';
  const KEY_PREFIX = 'yearbook-help-key-';
  const BASE_KEY = 'yearbook-help-synced';
  const PATH = 'tickets.json';

  let base = readBase();          // { sha, etag, data } or null
  let status = { state: 'off', detail: '', at: null };
  let running = null, rerun = false, timer = null, connecting = false;

  /* ---------- small helpers ---------- */

  function readBase() { try { return JSON.parse(lsGet(BASE_KEY)) || null; } catch (e) { return null; } }
  function writeBase() { lsSet(BASE_KEY, base ? JSON.stringify(base) : null); }

  const accessKey = () => lsGet(KEY_PREFIX + ROLE);
  const configured = () => !!accessKey();
  const repo = () => CONFIG.dataRepo;

  function fail(kind, message) { return Object.assign(new Error(message), { kind: kind }); }

  /* Canonical JSON: key order never counts as a change. */
  function canon(v) {
    if (v === undefined) return '~';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }

  const copy = v => JSON.parse(JSON.stringify(v));
  const snapshot = () => copy({ tickets: DB.tickets, settings: DB.settings });
  const shape = d => ({ tickets: Array.isArray(d && d.tickets) ? d.tickets : [], settings: (d && d.settings) || {} });

  /* One ticket per line, so a new request shows up in GitHub's history as a one-line change. */
  function serialize(data) {
    const t = data.tickets;
    return '{\n"settings": ' + JSON.stringify(data.settings) + ',\n"tickets": ['
      + (t.length ? '\n  ' + t.map(x => JSON.stringify(x)).join(',\n  ') + '\n' : '') + ']\n}\n';
  }

  function toB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function fromB64(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------- GitHub ---------- */

  async function gh(path, opts) {
    opts = opts || {};
    const headers = Object.assign({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + (opts.key || accessKey())
    }, opts.headers || {});
    try {
      return await fetch(CONFIG.apiBase + '/repos/' + repo() + path, {
        method: opts.method || 'GET', headers: headers, body: opts.body, cache: 'no-store'
      });
    } catch (e) {
      throw fail('offline', 'No connection — changes are kept on this device and will sync when it is back.');
    }
  }

  function httpFail(res) {
    if (res.status === 401) return fail('auth', 'GitHub rejected the access key — it may have expired. Paste a new one.');
    if (res.status === 403 || res.status === 429) {
      if (res.headers.get('x-ratelimit-remaining') === '0') return fail('busy', 'GitHub asked us to slow down — sync will pick up again in a few minutes.');
      return fail('auth', 'The access key can read ' + repo() + ' but not change it. It needs Contents: Read and write.');
    }
    if (res.status === 404) return fail('repo', 'Cannot find ' + repo() + '. Check that the repository exists and the access key includes it.');
    return fail('http', 'GitHub returned an error (' + res.status + '). Will try again.');
  }

  async function getFile(etag) {
    const res = await gh('/contents/' + PATH, { headers: etag ? { 'If-None-Match': etag } : {} });
    if (res.status === 304) return { notModified: true };
    if (res.status === 404) return { missing: true };
    if (!res.ok) throw httpFail(res);
    const meta = await res.json();
    let b64 = meta.content;
    if (!b64 && meta.size > 0) {
      // Over 1 MB the contents API leaves the content out; the blob API still serves it.
      const blob = await gh('/git/blobs/' + meta.sha);
      if (!blob.ok) throw httpFail(blob);
      b64 = (await blob.json()).content;
    }
    let data = {};
    if (b64) {
      try { data = JSON.parse(fromB64(b64)); }
      catch (e) { throw fail('data', PATH + ' in ' + repo() + ' is not valid JSON. Was it edited by hand? Restore an earlier version from its history.'); }
    }
    return { sha: meta.sha, etag: res.headers.get('ETag'), data: shape(data) };
  }

  async function putFile(data, sha) {
    const body = {
      message: (ROLE === 'station' ? 'Help station' : 'Staff desk') + ': update ' + PATH,
      content: toB64(serialize(data))
    };
    if (sha) body.sha = sha;
    const res = await gh('/contents/' + PATH, {
      method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }
    });
    // 409: the file moved on since `sha`; 422: it exists but we thought it didn't.
    if (res.status === 409 || res.status === 422) return { conflict: true };
    if (!res.ok) throw httpFail(res);
    return { sha: (await res.json()).content.sha };
  }

  /* ---------- merging ---------- */

  /* b is the last agreed version of a thing (null when there is no shared history).
     A field this device hasn't touched since b takes the remote value. */
  function mergeFields(b, l, r, skip) {
    const out = {};
    new Set(Object.keys(l).concat(Object.keys(r))).forEach(k => {
      if (k === skip) return;
      const v = !b ? (k in l ? l[k] : r[k]) : (canon(l[k]) === canon(b[k]) ? r[k] : l[k]);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  function mergeTicket(b, l, r) {
    const out = mergeFields(b, l, r, 'notes');
    const seen = new Set();
    out.notes = (r.notes || []).concat(l.notes || [])
      .filter(n => n && !seen.has(n.id) && seen.add(n.id))
      .sort((x, y) => String(x.at).localeCompare(String(y.at)));
    if (String(r.updatedAt) > String(out.updatedAt)) out.updatedAt = r.updatedAt;
    return out;
  }

  function mergeTickets(b, l, r) {
    const index = list => new Map((list || []).map(x => [x.id, x]));
    const bm = index(b), lm = index(l), rm = index(r);
    const out = [], seen = new Set();
    r.concat(l).forEach(x => {
      if (!x || seen.has(x.id)) return;
      seen.add(x.id);
      const bt = b ? bm.get(x.id) : null, lt = lm.get(x.id), rt = rm.get(x.id);
      let v;
      if (lt && rt) v = mergeTicket(bt, lt, rt);
      else if (!bt) v = lt || rt;                                          // new on one side
      else if (lt) v = canon(lt) === canon(bt) ? null : lt;                // deleted elsewhere, unless changed here
      else v = null;                                                       // deleted here
      if (v) out.push(v);
    });
    return out;
  }

  function merge(b, l, r) {
    let settings;
    if (b) settings = mergeFields(b.settings, l.settings, r.settings);
    else {
      // With no shared history the shared settings beat this device's defaults,
      // but staff names typed on either side are all kept.
      settings = Object.assign({}, l.settings, r.settings);
      settings.staff = Array.from(new Set((r.settings.staff || []).concat(l.settings.staff || [])));
    }
    return { tickets: mergeTickets(b ? b.tickets : null, l.tickets, r.tickets), settings: settings };
  }

  /* Swap the merged data into the live copy without firing tickets:changed. */
  function applyLocal(data) {
    DB = migrate(copy(data));
    persistQuietly();
  }

  /* ---------- the sync itself ---------- */

  async function syncFile() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const b = base;
      const remote = await getFile(b && b.etag);
      const r = remote.notModified ? b.data : remote.missing ? null : remote.data;
      const sha = remote.notModified ? b.sha : remote.missing ? null : remote.sha;
      const etag = remote.notModified ? b.etag : remote.missing ? null : remote.etag;

      const l = snapshot();
      const merged = r ? merge(b ? b.data : null, l, r) : l;

      let newSha = sha, newEtag = etag;
      if (!r || canon(merged) !== canon(r)) {
        const put = await putFile(merged, sha);
        if (put.conflict) continue;        // another device saved first: fetch and merge again
        newSha = put.sha;
        newEtag = null;
      }
      base = { sha: newSha, etag: newEtag, data: merged };

      // Anything done on this device while we were talking to GitHub stays on top,
      // and goes up on the next pass.
      const now = snapshot();
      let result = merged;
      if (canon(now) !== canon(l)) { result = merge(l, now, merged); rerun = true; }
      if (canon(result) === canon(now)) return false;
      applyLocal(result);
      return true;
    }
    throw fail('conflict', 'Another device kept saving at the same moment. Will try again shortly.');
  }

  async function syncNow() {
    if (!configured() || connecting) return;
    if (running) { rerun = true; return running; }
    running = (async () => {
      setStatus('syncing', '');
      let changed = false;
      try {
        changed = await syncFile();
        writeBase();
        setStatus('ok', '');
      } catch (e) {
        setStatus(e.kind === 'offline' ? 'offline' : 'error', e.message);
        if (!e.kind) console.error('Sync failed', e);
      }
      if (changed) window.dispatchEvent(new Event('tickets:reloaded'));
    })();
    try { await running; } finally { running = null; }
    if (rerun) { rerun = false; schedule(250); }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(syncNow, ms);
  }

  function setStatus(state, detail) {
    status = { state: state, detail: detail || '', at: state === 'ok' ? Date.now() : status.at };
    window.dispatchEvent(new Event('sync:status'));
  }

  const pendingChanges = () => !!base && canon(snapshot()) !== canon(base.data);

  /* ---------- connecting a device ---------- */

  /* Checks the key, then syncs. Tickets already on this device and tickets already
     in the shared file are both kept. */
  async function connect(key) {
    key = String(key || '').trim();
    if (!key) throw fail('auth', 'Paste the access key first.');
    connecting = true;
    try {
      const probe = await gh('', { key: key });
      if (!probe.ok) throw httpFail(probe);
      lsSet(KEY_PREFIX + ROLE, key);
    } finally {
      connecting = false;
    }
    await syncNow();
    if (status.state === 'error') throw fail('sync', status.detail);
  }

  function disconnect() {
    lsSet(KEY_PREFIX + ROLE, null);
    base = null;
    writeBase();
    clearTimeout(timer);
    setStatus('off', '');
  }

  /* ---------- for the pages ---------- */

  function describe() {
    const s = status.state;
    if (s === 'off') return { tone: 'off', text: '' };
    if (s === 'syncing') return { tone: 'busy', text: 'Syncing…' };
    if (s === 'offline') return { tone: 'warn', text: 'Offline — saved on this device' };
    if (s === 'error') return { tone: 'error', text: 'Sync problem' };
    if (pendingChanges()) return { tone: 'busy', text: 'Saving…' };
    return { tone: 'ok', text: 'Synced' };
  }

  window.addEventListener('tickets:changed', () => {
    if (!configured()) return;
    if (status.state === 'ok' || status.state === 'syncing') setStatus(status.state, '');
    schedule(700);
  });
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  window.addEventListener('storage', e => {
    if (e.key === BASE_KEY) base = readBase();
    // The other page on this same device changed something.
    if (e.key === STORE_KEY) { DB = loadDB(); window.dispatchEvent(new Event('tickets:reloaded')); }
  });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, (CONFIG.pollSeconds || 20) * 1000);

  if (configured()) syncNow();

  return {
    role: ROLE, repo: repo, configured: configured, key: accessKey,
    status: () => status, describe: describe, pendingChanges: pendingChanges,
    syncNow: syncNow, connect: connect, disconnect: disconnect,
    // exposed for tests
    _merge: merge, _serialize: serialize
  };
})();
