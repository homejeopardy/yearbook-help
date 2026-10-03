/* ---------------------------------------------------------------
   The help page: someone who is stuck ordering a yearbook fills in
   a request and gets a ticket code, or types a code to see how their
   request is going. It never shows anyone else's ticket.

   On a set-up station (a device where the access key was pasted) the
   request is saved and synced. Anywhere else nothing can be saved —
   the form turns the request into an email instead (CONFIG.helpEmail).
   --------------------------------------------------------------- */

(function () {
  const view = $('#view');
  const IDLE_MS = 90 * 1000;
  let screen = 'home', idleTimer = null, lastTicketId = null, lookupCode = '';

  $('#title').textContent = CONFIG.title;
  document.title = CONFIG.title;

  const connected = () => Sync.configured();

  /* ---------- screens ---------- */

  function home() {
    const order = CONFIG.orderUrl
      ? '<p class="hint">Just want to order? <a href="' + esc(CONFIG.orderUrl) + '" target="_blank" rel="noopener">Go to the order page</a>.</p>' : '';
    return '<h2 class="lead">Stuck ordering your yearbook?</h2>'
      + '<p class="sub">Tell us what went wrong and yearbook staff will sort it out.</p>'
      + '<div class="choices">'
      + '<button class="choice" data-go="form" type="button"><span class="choice-big">I need help</span><span>Start a new request</span></button>'
      + (connected() ? '<button class="choice choice-alt" data-go="lookup" type="button"><span class="choice-big">Check my ticket</span><span>I already have a code</span></button>' : '')
      + '</div>' + order + writeUs('Or email yearbook staff at ');
  }

  function writeUs(lead) {
    return CONFIG.helpEmail ? '<p class="hint">' + lead + '<a href="mailto:' + esc(CONFIG.helpEmail) + '">' + esc(CONFIG.helpEmail) + '</a>.</p>' : '';
  }

  function form() {
    const opts = (list, get) => list.map(x => '<option value="' + esc(get ? x.id : x) + '">' + esc(get ? x.label : x) + '</option>').join('');
    return '<button class="back" data-go="home" type="button">← Back</button>'
      + '<h2 class="lead">What do you need help with?</h2>'
      + '<form id="reqForm" novalidate>'
      + '<label>Student\'s name <input name="name" autocomplete="off" required></label>'
      + '<div class="row">'
      + '<label>Grade or homeroom <input name="grade" autocomplete="off"></label>'
      + '<label>I am a <select name="who">' + opts(WHO) + '</select></label>'
      + '</div>'
      + '<label>What\'s the problem? <select name="category" required><option value="">Choose one…</option>' + opts(CATEGORIES, true) + '</select></label>'
      + '<label>Tell us what happened <textarea name="details" rows="4" required placeholder="What you tried, and what you saw"></textarea></label>'
      + '<div class="row">'
      + '<label>Email for updates <input name="contact" type="email" inputmode="email" autocomplete="off" placeholder="Yours or a parent\'s"></label>'
      + '<label>Order or confirmation number <input name="orderRef" autocomplete="off" placeholder="If you have one"></label>'
      + '</div>'
      + '<p class="warn">Never type a card number or a password here. We will not ask for them.</p>'
      + '<p id="formError" class="error" role="alert" hidden></p>'
      + '<button class="primary" type="submit">' + (connected() ? 'Send my request' : 'Write the email') + '</button>'
      + '</form>';
  }

  function done() {
    const t = getTicket(lastTicketId);
    if (!t) return home();
    return '<h2 class="lead">Got it. Here\'s your ticket.</h2>'
      + stub(t)
      + '<p class="sub">Write this code down or take a photo. Use it here to check on your request.'
      + (emailOf(t) ? ' We\'ll also email ' + esc(emailOf(t)) + ' when there\'s an update.' : '') + '</p>'
      + writeUs('Need to add something? Email ')
      + '<button class="primary" data-go="home" type="button">Done</button>';
  }

  function emailed() {
    return '<h2 class="lead">One more step: press send.</h2>'
      + '<p class="sub">Your email app should have opened with your request written out to ' + esc(CONFIG.helpEmail)
      + '. It isn\'t sent until you send it.</p>'
      + '<button class="primary" data-go="home" type="button">Done</button>';
  }

  function lookup() {
    const code = normalizeCode(lookupCode);
    const t = code ? getTicket(code) : null;
    let result = '';
    if (lookupCode && !t) result = '<p class="error" role="alert">We can\'t find a ticket with that code. Check it and try again.</p>';
    if (t) {
      const st = STATUSES.find(s => s.id === t.status) || STATUSES[0];
      const shared = t.notes.filter(n => n.shared);
      result = stub(t)
        + '<p class="sub">' + esc(st.forStudent) + '</p>'
        + (shared.length ? '<h3>Messages from yearbook staff</h3><ul class="notes">' + shared.map(n =>
          '<li><p>' + esc(n.text) + '</p><span class="meta">' + esc(fmtDate(n.at)) + '</span></li>').join('') + '</ul>' : '');
    }
    return '<button class="back" data-go="home" type="button">← Back</button>'
      + '<h2 class="lead">Check my ticket</h2>'
      + '<form id="lookupForm" class="lookup"><label>Ticket code <input name="code" class="code-input" autocomplete="off" autocapitalize="characters" placeholder="YB-0000" value="' + esc(lookupCode) + '"></label>'
      + '<button class="primary" type="submit">Look it up</button></form>'
      + result;
  }

  function stub(t) {
    const st = STATUSES.find(s => s.id === t.status) || STATUSES[0];
    return '<div class="stub"><div class="stub-main"><span class="meta">Ticket</span><strong class="stub-code">' + esc(t.id) + '</strong></div>'
      + '<div class="stub-side"><span class="meta">' + esc(labelOf(CATEGORIES, t.category)) + '</span>'
      + '<span class="status status-' + esc(t.status) + '">' + esc(st.label) + '</span>'
      + '<span class="meta">' + esc(fmtDate(t.createdAt)) + '</span></div></div>';
  }

  const SCREENS = { home: home, form: form, done: done, emailed: emailed, lookup: lookup };

  function go(next) {
    screen = next;
    if (next === 'home') { lastTicketId = null; lookupCode = ''; }
    view.innerHTML = SCREENS[screen]();
    const first = view.querySelector('input, select, textarea');
    if (first && screen !== 'home') first.focus();
    window.scrollTo(0, 0);
    resetIdle();
  }

  /* ---------- sending a request ---------- */

  function submit(formEl) {
    const fields = Object.fromEntries(new FormData(formEl));
    const err = $('#formError');
    const missing = !fields.name.trim() ? 'the student\'s name' : !fields.category ? 'what the problem is' : !fields.details.trim() ? 'what happened' : '';
    if (missing) {
      err.textContent = 'Please fill in ' + missing + '.';
      err.hidden = false;
      return;
    }
    if (connected()) {
      lastTicketId = createTicket(fields, 'station').id;
      return go('done');
    }
    if (!CONFIG.helpEmail) {
      err.textContent = 'This page can\'t send requests from this device. Please use the help station in the yearbook room.';
      err.hidden = false;
      return;
    }
    const body = [
      'Student: ' + fields.name.trim() + (fields.grade.trim() ? ' (' + fields.grade.trim() + ')' : ''),
      'From: ' + fields.who,
      'Problem: ' + labelOf(CATEGORIES, fields.category),
      fields.orderRef.trim() ? 'Order number: ' + fields.orderRef.trim() : '',
      fields.contact.trim() ? 'Email: ' + fields.contact.trim() : '',
      '', fields.details.trim()
    ].filter((line, i) => line || i === 5).join('\n');
    location.href = mailLink({ to: CONFIG.helpEmail, subject: 'Yearbook order help: ' + labelOf(CATEGORIES, fields.category), body: body }, 'mailto');
    go('emailed');
  }

  /* ---------- station setup ---------- */

  function renderSetup(message) {
    const body = $('#setupBody');
    if (connected()) {
      body.innerHTML = '<p>This device is a help station. Requests made here are saved to <code>' + esc(Sync.repo()) + '</code>.</p>'
        + '<p class="meta">' + esc(Sync.status().detail || 'Sync is working.') + '</p>'
        + '<div class="actions"><button type="button" id="setupOff" class="danger">Disconnect this station</button><button class="primary">Close</button></div>';
    } else {
      body.innerHTML = '<p>A yearbook staff member signs in to turn this device into a help station.</p>'
        + '<label>Your name <input id="setupName" autocomplete="username"></label>'
        + '<label>Password <input id="setupPass" type="password" autocomplete="current-password"></label>'
        + '<p id="setupMsg" class="error" role="alert"' + (message ? '' : ' hidden') + '>' + esc(message || '') + '</p>'
        + '<div class="actions"><button type="button" id="setupCancel">Cancel</button><button type="button" id="setupGo" class="primary">Connect</button></div>';
    }
  }

  async function connectAs(name, password) {
    const account = await Accounts.find(name);
    if (!account) throw new Error('There\'s no account for ' + (name.trim() || 'that name') + '. Make one first by signing in at the staff desk.');
    await Sync.connect(await Accounts.unlock(account, password));
  }

  $('#setupBtn').addEventListener('click', () => { renderSetup(); $('#setupDlg').showModal(); });
  $('#setupDlg').addEventListener('click', async e => {
    if (e.target.id === 'setupCancel') $('#setupDlg').close();
    if (e.target.id === 'setupOff') { Sync.disconnect(); renderSetup(); go('home'); }
    if (e.target.id === 'setupGo') {
      e.target.disabled = true;
      try { await connectAs($('#setupName').value, $('#setupPass').value); renderSetup(); go('home'); }
      catch (err) { renderSetup(err.message); }
    }
  });

  /* ---------- wiring ---------- */

  view.addEventListener('click', e => {
    const btn = e.target.closest('[data-go]');
    if (btn) go(btn.dataset.go);
  });

  view.addEventListener('submit', e => {
    e.preventDefault();
    if (e.target.id === 'reqForm') submit(e.target);
    if (e.target.id === 'lookupForm') { lookupCode = e.target.code.value.trim(); go('lookup'); }
  });

  /* A shared station must not leave one person's half-typed request for the next. */
  function resetIdle() {
    clearTimeout(idleTimer);
    if (screen === 'home') return;
    idleTimer = setTimeout(() => { if (!$('#setupDlg').open) go('home'); else resetIdle(); }, IDLE_MS);
  }
  ['input', 'keydown', 'pointerdown'].forEach(ev => document.addEventListener(ev, resetIdle, true));

  // A ticket on screen picks up staff changes as they sync in; a form in progress is left alone.
  window.addEventListener('tickets:reloaded', () => { if (screen === 'lookup' || screen === 'done') view.innerHTML = SCREENS[screen](); });
  window.addEventListener('sync:status', () => renderSyncPill($('#syncPill')));

  renderSyncPill($('#syncPill'));
  go('home');
})();
