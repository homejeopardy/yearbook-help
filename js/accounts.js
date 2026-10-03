/* ---------------------------------------------------------------
   Staff accounts, so nobody has to paste the access key.

   The access key can't be written into this public site: anyone
   could then read every ticket, and GitHub cancels a key it finds
   in a public repository. Instead, each account keeps its own copy
   of the key, locked with that person's password, in accounts.json
   in a small PUBLIC repository. Signing in unlocks the copy; without
   the password the file is useless.

   - A password is picked the first time, on a computer that is
     already connected (that is where the key to lock up comes from).
   - Passwords are never stored or sent anywhere. Forgetting one means
     resetting the account (staff desk → Settings) and picking again.
   - The file is public, so a short or guessable password can be
     guessed by someone patient. Eight characters is the minimum.
   --------------------------------------------------------------- */

const Accounts = (function () {
  const PATH = 'accounts.json';
  const ITERATIONS = 310000;
  const MIN_PASSWORD = 8;
  const enc = new TextEncoder(), dec = new TextDecoder();

  const repo = () => CONFIG.accountsRepo;
  const norm = u => String(u || '').trim().toLowerCase();
  const b64 = buf => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  function fail(kind, message) { return Object.assign(new Error(message), { kind: kind }); }

  async function keyFor(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function request(method, body, token) {
    const headers = { Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(CONFIG.apiBase + '/repos/' + repo() + '/contents/' + PATH,
        { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch (e) {
      throw fail('offline', 'No connection. Check the Wi-Fi and try again.');
    }
  }

  /* Anyone can read the list (it is public); only a connected computer can change it. */
  async function load() {
    const token = Sync.key();
    const res = await request('GET', null, token);
    if (res.status === 404) return { accounts: [], sha: null };
    if (res.ok) {
      const meta = await res.json();
      const text = dec.decode(unb64(String(meta.content || '').replace(/\s/g, '')));
      return { accounts: (text.trim() ? JSON.parse(text).accounts : null) || [], sha: meta.sha };
    }
    if (!token) {
      // GitHub limits how often a school's shared connection may ask without a key; the plain file still works.
      try {
        const raw = await fetch('https://raw.githubusercontent.com/' + repo() + '/HEAD/' + PATH, { cache: 'no-store' });
        if (raw.ok) return { accounts: (await raw.json()).accounts || [], sha: null };
      } catch (e) { /* fall through */ }
    }
    throw fail('http', 'Could not load the staff accounts (' + res.status + '). Try again in a minute.');
  }

  async function change(fn) {
    const token = Sync.key();
    if (!token) throw fail('auth', 'This computer is not connected.');
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await load();
      const next = fn(cur.accounts.slice());
      const text = '{"accounts": [' + (next.length ? '\n  ' + next.map(a => JSON.stringify(a)).join(',\n  ') + '\n' : '') + ']}\n';
      const body = { message: 'Update staff accounts', content: b64(enc.encode(text)) };
      if (cur.sha) body.sha = cur.sha;
      const res = await request('PUT', body, token);
      if (res.ok) return next;
      if (res.status === 404 || res.status === 403) throw fail('repo', 'The access key can\'t write to ' + repo() + '. It needs Contents: Read and write on that repository too.');
      if (res.status !== 409 && res.status !== 422) throw fail('http', 'Could not save the account (' + res.status + ').');
    }
    throw fail('conflict', 'Could not save the account. Try again.');
  }

  async function find(user) {
    return (await load()).accounts.find(a => a.user === norm(user)) || null;
  }

  /* Returns the access key locked inside the account, or throws if the password is wrong. */
  async function unlock(account, password) {
    try {
      const key = await keyFor(password, unb64(account.salt), account.iter);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(account.iv) }, key, unb64(account.box));
      return JSON.parse(dec.decode(plain)).token;
    } catch (e) {
      throw fail('password', 'That password isn\'t right.');
    }
  }

  /* Creates the account, or re-locks it (new password, or a replaced access key). */
  async function save(name, password, token) {
    if (String(password).length < MIN_PASSWORD) throw fail('password', 'Pick a password with at least ' + MIN_PASSWORD + ' characters.');
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFor(password, salt, ITERATIONS);
    const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify({ token: token })));
    const account = { user: norm(name), name: String(name).trim(), salt: b64(salt), iv: b64(iv), box: b64(box), iter: ITERATIONS, at: new Date().toISOString() };
    await change(list => list.filter(a => a.user !== account.user).concat(account));
    return account;
  }

  function remove(users) {
    const gone = [].concat(users).map(norm);
    return change(list => list.filter(a => !gone.includes(a.user)));
  }

  return { load: load, find: find, unlock: unlock, save: save, remove: remove, norm: norm, repo: repo, MIN_PASSWORD: MIN_PASSWORD };
})();
