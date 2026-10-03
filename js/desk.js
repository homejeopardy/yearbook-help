/* ---------------------------------------------------------------
   The staff desk: the queue of requests, and one ticket at a time —
   who is on it, where it stands, and the notes about it.
   --------------------------------------------------------------- */

(function () {
  const ME_KEY = 'yearbook-help-me';
  const TABS = [
    { id: 'open', label: 'Open', test: isOpen },
    { id: 'new', label: 'New', test: t => t.status === 'new' },
    { id: 'waiting', label: 'Waiting', test: t => t.status === 'waiting' },
    { id: 'resolved', label: 'Resolved', test: t => t.status === 'resolved' },
    { id: 'all', label: 'All', test: () => true }
  ];

  let tab = 'open', query = '', selected = null;
  const drafts = {};   // ticket id -> { text, shared }: a half-written note survives a sync

  const me = () => lsGet(ME_KEY) || '';
  // The sign-in screen keeps other people out of the queue on a shared computer. What keeps
  // the public out is that a computer only gets the access key by unlocking an account.
  const signedIn = () => Sync.configured() && !!me();
  let gate = null;     // the sign-in screen's state while it is showing

  /* ---------- the queue ---------- */

  function visible() {
    const q = query.trim().toLowerCase();
    const test = TABS.find(x => x.id === tab).test;
    return DB.tickets.filter(t => test(t) && (!q || [t.id, t.name, t.grade, t.contact, t.details, t.orderRef, t.assignee]
      .join(' ').toLowerCase().includes(q)))
      .sort((a, b) => {
        if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
        if (!isOpen(a)) return String(b.resolvedAt || b.updatedAt).localeCompare(String(a.resolvedAt || a.updatedAt));
        if (!!a.urgent !== !!b.urgent) return a.urgent ? -1 : 1;
        return String(a.createdAt).localeCompare(String(b.createdAt));   // longest wait first
      });
  }

  function renderTabs() {
    $('#tabs').innerHTML = TABS.map(x =>
      '<button type="button" role="tab" data-tab="' + x.id + '" aria-selected="' + (x.id === tab) + '">'
      + esc(x.label) + ' <span class="count">' + DB.tickets.filter(x.test).length + '</span></button>').join('');
  }

  function renderList() {
    const rows = visible();
    $('#list').innerHTML = rows.length ? rows.map(t =>
      '<li><button type="button" class="row-btn' + (t.id === selected ? ' is-on' : '') + '" data-id="' + esc(t.id) + '">'
      + '<span class="row-top"><strong>' + esc(t.name || 'No name') + '</strong>'
      + (t.urgent ? '<span class="flag">Urgent</span>' : '')
      + '<span class="meta">' + esc(isOpen(t) ? age(t.createdAt) : fmtDate(t.resolvedAt || t.updatedAt)) + '</span></span>'
      + '<span class="row-mid">' + esc(labelOf(CATEGORIES, t.category)) + '</span>'
      + '<span class="row-bot"><span class="code">' + esc(t.id) + '</span>'
      + '<span class="status status-' + esc(t.status) + '">' + esc(labelOf(STATUSES, t.status)) + '</span>'
      + '<span class="meta">' + esc(t.assignee || 'Unassigned') + '</span></span>'
      + '</button></li>').join('')
      : '<li class="empty">' + (DB.tickets.length ? 'Nothing here.' : 'No tickets yet. Requests from the help station show up here.') + '</li>';
  }

  /* ---------- one ticket ---------- */

  function renderDetail() {
    const el = $('#detail');
    const t = selected && getTicket(selected);
    if (!t) {
      selected = null;
      el.innerHTML = '<p class="empty">Pick a ticket to see it.</p>';
      return;
    }
    const draft = drafts[t.id] || { text: '', shared: false };
    const staff = DB.settings.staff || [];
    const people = staff.includes(t.assignee) || !t.assignee ? staff : staff.concat(t.assignee);
    const field = (label, value) => value ? '<div><dt>' + label + '</dt><dd>' + esc(value) + '</dd></div>' : '';

    el.innerHTML = '<div class="detail-head">'
      + '<div><span class="code code-big">' + esc(t.id) + '</span><h2>' + esc(t.name || 'No name') + '</h2>'
      + '<p class="meta">' + esc(labelOf(CATEGORIES, t.category)) + ' · opened ' + esc(fmtDate(t.createdAt))
      + (t.source === 'desk' ? ' · entered by staff' : t.source === 'email' ? ' · came in by email' : '') + '</p></div>'
      + '<button type="button" id="closeDetail" class="back">← Queue</button></div>'

      + '<div class="status-bar" role="group" aria-label="Status">' + STATUSES.map(s =>
        '<button type="button" data-status="' + s.id + '" class="status-btn' + (t.status === s.id ? ' is-on' : '') + '" aria-pressed="' + (t.status === s.id) + '">'
        + esc(s.id === 'waiting' ? 'Waiting on them' : s.label) + '</button>').join('') + '</div>'

      + '<div class="controls">'
      + '<label>Assigned to <select id="assignee"><option value="">Unassigned</option>'
      + people.map(p => '<option' + (p === t.assignee ? ' selected' : '') + '>' + esc(p) + '</option>').join('') + '</select></label>'
      + '<label class="check"><input type="checkbox" id="urgent"' + (t.urgent ? ' checked' : '') + '> Urgent</label>'
      + '</div>'

      + '<blockquote class="ask">' + esc(t.details) + '</blockquote>'
      + '<dl class="facts">' + field('From', t.who) + field('Grade / homeroom', t.grade) + field('Email', t.contact)
      + field('Order number', t.orderRef) + '</dl>'

      + (emailOf(t) ? '<p class="mail-line"><a id="mailBtn" class="linkish" target="_blank" rel="noopener" href="' + esc(mailLink(updateEmail(t), CONFIG.mailVia)) + '">Email them where this stands</a></p>'
        : '<p class="meta mail-line">No email address on this ticket, so updates can\'t be emailed.</p>')

      + '<h3>Notes</h3>'
      + (t.notes.length ? '<ul class="notes">' + t.notes.map(n =>
        '<li class="' + (n.shared ? 'is-shared' : '') + '"><p>' + esc(n.text) + '</p><span class="meta">' + esc(n.by) + ' · ' + esc(fmtDate(n.at))
        + (n.shared ? ' · shown to them' : '') + '</span></li>').join('') + '</ul>' : '<p class="meta">No notes yet.</p>')
      + '<form id="noteForm" class="note-form">'
      + '<textarea id="noteText" rows="3" placeholder="What you did, or what you need from them" aria-label="New note">' + esc(draft.text) + '</textarea>'
      + '<div class="actions"><label class="check"><input type="checkbox" id="noteShared"' + (draft.shared ? ' checked' : '') + '> Show this to them when they look up the ticket</label>'
      + '<button class="primary" type="submit" id="noteGo">' + noteLabel(t, draft.shared) + '</button></div></form>'

      + '<button type="button" id="deleteBtn" class="danger linkish">Delete this ticket</button>';
  }

  const noteLabel = (t, shared) => shared && emailOf(t) ? 'Add note and email them' : 'Add note';

  function render() {
    const locked = !signedIn();
    document.body.classList.toggle('locked', locked);
    $('#gate').hidden = !locked;
    $('#signOutBtn').textContent = 'Sign out' + (me() ? ' (' + me() + ')' : '');
    if (locked) { if (!gate) showGate(); return; }
    gate = null;
    renderTabs(); renderList(); renderDetail(); renderBanner();
    document.body.classList.toggle('has-selection', !!selected);
  }

  function renderBanner() {
    const b = $('#banner'), s = Sync.status();
    const text = !Sync.configured() ? 'Not connected: tickets on this computer stay on this computer. Connect in Settings to share the queue.'
      : s.state === 'error' ? s.detail : '';
    b.textContent = text;
    b.hidden = !text;
  }

  /* ---------- signing in ---------- */

  function showGate(next) {
    gate = Object.assign({ step: 'user', name: '', account: null, error: '', note: '' }, next);
    const err = '<p class="error" role="alert"' + (gate.error ? '' : ' hidden') + '>' + esc(gate.error) + '</p>';
    const back = '<button type="button" class="linkish" data-gate="user">← Not you?</button>';
    let html;
    if (gate.step === 'user') {
      html = '<h2 class="lead">Staff sign in</h2>'
        + (gate.note ? '<p class="sub">' + esc(gate.note) + '</p>' : '')
        + '<label>Your name <input name="name" autocomplete="username" autocapitalize="words" value="' + esc(gate.name) + '"></label>' + err
        + '<div class="actions">' + (Sync.configured() ? '' : '<button type="button" class="linkish" data-gate="key">Set up with an access key</button>')
        + '<button class="primary" type="submit">Continue</button></div>';
    } else if (gate.step === 'password') {
      html = '<h2 class="lead">Hi, ' + esc(gate.name) + '</h2>'
        + '<input name="name" autocomplete="username" value="' + esc(gate.name) + '" hidden>'
        + '<label>Password <input name="password" type="password" autocomplete="current-password"></label>' + err
        + '<div class="actions">' + back + '<button class="primary" type="submit">Sign in</button></div>';
    } else if (gate.step === 'create') {
      html = '<h2 class="lead">Welcome, ' + esc(gate.name) + '</h2>'
        + '<p class="sub">It\'s your first time, so pick a password. You\'ll use it with your name to sign in on any computer.</p>'
        + '<input name="name" autocomplete="username" value="' + esc(gate.name) + '" hidden>'
        + '<label>New password <input name="password" type="password" autocomplete="new-password"></label>'
        + '<label>Type it again <input name="again" type="password" autocomplete="new-password"></label>'
        + '<p class="meta">At least ' + Accounts.MIN_PASSWORD + ' characters. Nobody can look it up for you, but it can be reset.</p>' + err
        + '<div class="actions">' + back + '<button class="primary" type="submit">Save and sign in</button></div>';
    } else {
      html = '<h2 class="lead">Set up this computer</h2>'
        + '<p class="sub">Only needed once, on the very first computer. After that, people sign in with their name and password.</p>'
        + '<label>Access key <input name="key" type="password" autocomplete="off"></label>' + err
        + '<div class="actions">' + back.replace('Not you?', 'Back') + '<button class="primary" type="submit">Connect</button></div>';
    }
    $('#gateForm').innerHTML = html;
    const first = $('#gateForm input:not([hidden])');
    if (first) first.focus();
  }

  const sameName = (a, b) => Accounts.norm(a) === Accounts.norm(b);

  async function gateSubmit(f) {
    if (gate.step === 'key') {
      await Sync.connect(f.key.value);
      return showGate({ note: 'Connected. Now type your name to make your account.' });
    }
    if (gate.step === 'user') {
      const typed = f.name.value.trim();
      if (!typed) return showGate({ error: 'Type your name.' });
      const all = (await Accounts.load()).accounts;
      const account = all.find(a => sameName(a.user, typed));
      if (account) return showGate({ step: 'password', name: account.name, account: account });
      if (!Sync.configured()) {
        return showGate({ name: typed, error: 'There\'s no account for ' + typed + ' yet. The first time, sign in on a yearbook computer that\'s already set up and you\'ll be asked to pick a password.' });
      }
      await Sync.syncNow();     // so the staff list is the current one
      const staff = DB.settings.staff || [];
      const listed = staff.find(p => sameName(p, typed));
      // The very first account, before there is a staff list, is whoever is setting things up.
      if (listed || (!staff.length && !all.length)) return showGate({ step: 'create', name: listed || typed });
      return showGate({ name: typed, error: typed + ' isn\'t on the yearbook staff list. Ask someone who is signed in to add you in Settings.' });
    }
    if (gate.step === 'password') {
      const token = await Accounts.unlock(gate.account, f.password.value);
      if (!Sync.configured()) {
        try { await Sync.connect(token); }
        catch (e) {
          if (e.kind !== 'auth' && e.kind !== 'repo') throw e;
          throw new Error('Your password is right, but the access key saved with your account no longer works. Sign in once on a yearbook computer that\'s set up and it will fix itself.');
        }
      } else if (token !== Sync.key()) {
        // The access key was replaced since this account was made: lock up the new one.
        Accounts.save(gate.account.name, f.password.value, Sync.key()).catch(() => {});
      }
      return signIn(gate.account.name);
    }
    if (gate.step === 'create') {
      if (f.password.value !== f.again.value) throw new Error('Those two passwords don\'t match.');
      await Accounts.save(gate.name, f.password.value, Sync.key());
      if (!(DB.settings.staff || []).some(p => sameName(p, gate.name))) saveSettings({ staff: (DB.settings.staff || []).concat(gate.name) });
      return signIn(gate.name);
    }
  }

  function signIn(name) {
    lsSet(ME_KEY, name);
    render();
  }

  $('#gateForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#gateForm [type=submit]');
    btn.disabled = true;
    try { await gateSubmit(e.target); }
    catch (err) { showGate({ step: gate.step, name: gate.name, account: gate.account, error: err.message }); }
  });
  $('#gateForm').addEventListener('click', e => {
    const to = e.target.dataset && e.target.dataset.gate;
    if (to) showGate({ step: to });
  });
  $('#signOutBtn').addEventListener('click', () => { lsSet(ME_KEY, null); selected = null; render(); });

  /* ---------- new ticket (walk-ups, emails, phone calls) ---------- */

  function openNew() {
    const opts = (list, get) => list.map(x => '<option value="' + esc(get ? x.id : x) + '">' + esc(get ? x.label : x) + '</option>').join('');
    $('#newForm').innerHTML = '<h2>New ticket</h2>'
      + '<label>Student\'s name <input name="name" autocomplete="off" required></label>'
      + '<div class="row"><label>Grade or homeroom <input name="grade" autocomplete="off"></label>'
      + '<label>Asked by <select name="who">' + opts(WHO) + '</select></label></div>'
      + '<label>Problem <select name="category" required>' + opts(CATEGORIES, true) + '</select></label>'
      + '<label>What happened <textarea name="details" rows="3" required></textarea></label>'
      + '<div class="row"><label>Their email <input name="contact" type="email" autocomplete="off"></label>'
      + '<label>Order number <input name="orderRef" autocomplete="off"></label></div>'
      + '<div class="actions"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Create ticket</button></div>';
    $('#newDlg').showModal();
  }

  $('#newForm').addEventListener('submit', e => {
    const t = createTicket(Object.fromEntries(new FormData(e.target)), 'desk');
    selected = t.id;
    if (!TABS.find(x => x.id === tab).test(t)) tab = 'open';
    render();
  });

  /* ---------- settings ---------- */

  function openSettings() {
    const staff = DB.settings.staff || [];
    const sync = '<p>Connected to <code>' + esc(Sync.repo()) + '</code>. ' + esc(Sync.status().detail || '') + '</p>'
      + '<p class="meta">Disconnecting removes the access key and the tickets from this computer. Signing in with a name and password connects it again.</p>'
      + '<button type="button" id="syncOff" class="danger">Disconnect this computer</button>';
    $('#settingsForm').innerHTML = '<h2>Settings</h2>'
      + '<label>Yearbook staff, one per line <textarea id="staffList" rows="5">' + esc(staff.join('\n')) + '</textarea></label>'
      + '<p class="meta">Each person signs in with their name from this list. The first time, on a computer that\'s already connected, they pick a password.</p>'
      + '<ul id="acctList" class="accts"><li class="meta">Checking accounts…</li></ul>'
      + '<h3>Email</h3>'
      + '<label>Don\'t make tickets from these senders, one per line <textarea id="ignoreList" rows="4" placeholder="someone@blackpinecircle.org&#10;@vendor.com">' + esc((DB.settings.ignoreSenders || []).join('\n')) + '</textarea></label>'
      + '<p class="meta">Anyone else who emails ' + esc(CONFIG.helpEmail || 'the staff group') + ' gets a ticket automatically. Use an address, or @domain for everyone at one.</p>'
      + '<h3>Sharing</h3>' + sync
      + '<h3>Records</h3><button type="button" id="exportBtn">Download all tickets (CSV)</button>'
      + '<div class="actions"><button class="primary" type="submit">Done</button></div>';
    if (!$('#settingsDlg').open) $('#settingsDlg').showModal();
    Accounts.load().then(r => {
      if (!$('#acctList')) return;
      $('#acctList').innerHTML = staff.map(p => {
        const has = r.accounts.some(a => sameName(a.user, p));
        return '<li><strong>' + esc(p) + '</strong> <span class="meta">' + (has ? 'has a password' : 'hasn\'t signed in yet') + '</span>'
          + (has ? ' <button type="button" class="linkish" data-reset="' + esc(p) + '">Reset password</button>' : '') + '</li>';
      }).join('') || '<li class="meta">Add names above.</li>';
    }).catch(err => { if ($('#acctList')) $('#acctList').innerHTML = '<li class="error">' + esc(err.message) + '</li>'; });
  }

  function saveStaff() {
    const staff = Array.from(new Set($('#staffList').value.split('\n').map(s => s.trim()).filter(Boolean)));
    const ignore = Array.from(new Set($('#ignoreList').value.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean)));
    const next = { staff: staff, ignoreSenders: ignore };
    const was = { staff: DB.settings.staff || [], ignoreSenders: DB.settings.ignoreSenders || [] };
    if (JSON.stringify(next) !== JSON.stringify(was)) saveSettings(next);
    // Someone taken off the list loses their account too.
    const removed = was.staff.filter(p => !staff.some(q => sameName(p, q)));
    if (removed.length) Accounts.remove(removed).catch(() => {});
  }

  $('#settingsForm').addEventListener('submit', () => { saveStaff(); render(); });
  $('#settingsForm').addEventListener('change', e => {
    // Show the new names in the account list straight away.
    if (e.target.id === 'staffList') { saveStaff(); openSettings(); }
  });
  $('#settingsForm').addEventListener('click', async e => {
    if (e.target.id === 'syncOff') {
      if (Sync.pendingChanges() && !confirm('Some changes on this computer haven\'t synced yet and would be lost. Disconnect anyway?')) return;
      Sync.disconnect();
      lsSet(ME_KEY, null);
      lsSet(STORE_KEY, null);
      DB = migrate(null);
      selected = null;
      $('#settingsDlg').close();
      render();
    }
    if (e.target.dataset.reset && confirm('Reset ' + e.target.dataset.reset + '\'s password? They pick a new one the next time they sign in on a connected computer.')) {
      try { await Accounts.remove(e.target.dataset.reset); } catch (err) { alert(err.message); }
      openSettings();
    }
    if (e.target.id === 'exportBtn') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([ticketsToCSV()], { type: 'text/csv' }));
      a.download = 'yearbook-help-tickets.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    }
  });

  /* ---------- wiring ---------- */

  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) { tab = b.dataset.tab; render(); }
  });
  $('#search').addEventListener('input', e => { query = e.target.value; renderList(); });
  $('#list').addEventListener('click', e => {
    const b = e.target.closest('[data-id]');
    if (b) { selected = b.dataset.id; render(); }
  });
  $('#newBtn').addEventListener('click', openNew);
  $('#settingsBtn').addEventListener('click', () => openSettings());
  document.addEventListener('click', e => { if (e.target.matches('[data-close]')) e.target.closest('dialog').close(); });

  $('#detail').addEventListener('click', e => {
    if (e.target.id === 'closeDetail') { selected = null; render(); }
    const s = e.target.closest('[data-status]');
    if (s) {
      const patch = { status: s.dataset.status };
      // Picking a ticket up puts your name on it.
      const t = getTicket(selected);
      if (patch.status === 'working' && t && !t.assignee && me()) patch.assignee = me();
      updateTicket(selected, patch);
    }
    if (e.target.id === 'deleteBtn' && confirm('Delete ticket ' + selected + ' for good? This removes it for everyone.')) {
      delete drafts[selected];
      deleteTicket(selected);
    }
  });
  $('#detail').addEventListener('change', e => {
    if (e.target.id === 'assignee') updateTicket(selected, { assignee: e.target.value });
    if (e.target.id === 'urgent') updateTicket(selected, { urgent: e.target.checked });
    if (e.target.id === 'noteShared') {
      (drafts[selected] = drafts[selected] || { text: '' }).shared = e.target.checked;
      $('#noteGo').textContent = noteLabel(getTicket(selected), e.target.checked);
    }
  });
  $('#detail').addEventListener('input', e => {
    if (e.target.id === 'noteText') (drafts[selected] = drafts[selected] || { shared: false }).text = e.target.value;
  });
  $('#detail').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('#noteText').value, shared = $('#noteShared').checked;
    if (!text.trim()) return;
    delete drafts[selected];
    const t = addNote(selected, text, me() || 'Staff', shared);
    // A browser can't send mail by itself: this opens the update, already written, to send.
    if (t && shared && emailOf(t)) window.open(mailLink(updateEmail(t, text.trim()), CONFIG.mailVia), '_blank', 'noopener');
  });

  /* Re-render when anything changes, here or on another device — but never under
     someone's cursor while they are typing a note. */
  function refresh() {
    const typing = document.activeElement && document.activeElement.id === 'noteText';
    const pos = typing ? document.activeElement.selectionStart : 0;
    render();
    if (typing && $('#noteText')) { $('#noteText').focus(); $('#noteText').setSelectionRange(pos, pos); }
  }
  window.addEventListener('tickets:changed', refresh);
  window.addEventListener('tickets:reloaded', refresh);
  window.addEventListener('sync:status', () => { renderSyncPill($('#syncPill')); renderBanner(); });
  setInterval(renderList, 60 * 1000);   // keeps "3 h" honest

  renderSyncPill($('#syncPill'));
  render();
})();
