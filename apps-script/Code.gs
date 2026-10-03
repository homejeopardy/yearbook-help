/* ---------------------------------------------------------------
   Yearbook Order Help — email intake (Google Apps Script)

   Runs every five minutes in a school Google account that receives
   the yearbook Google Group's mail. Each new email to the group
   becomes a ticket in tickets.json, the same file the help station
   and staff desk sync with — unless the sender is on the "don't
   make tickets from" list kept in the staff desk's Settings.

   - A reply (same email thread, or a ticket code like YB-4K7Q in the
     subject) is added to that ticket as a note instead of opening a
     new one. If the ticket was waiting on them, it moves back to
     In progress.
   - Mail from the account running this script, automatic replies and
     bounces are ignored.
   - It only reads mail and writes tickets. It never sends, deletes or
     changes an email.

   Setup is in the README ("Tickets from email"). Script properties:
     GITHUB_TOKEN  the access key (Contents: read and write on the data repo)
     DATA_REPO     optional, default homejeopardy/yearbook-help-data
     GROUP         optional, default bpcyearbook@blackpinecircle.org
   --------------------------------------------------------------- */

var DEFAULTS = {
  DATA_REPO: 'homejeopardy/yearbook-help-data',
  GROUP: 'bpcyearbook@blackpinecircle.org',
  API: 'https://api.github.com'
};
var PATH = 'tickets.json';
var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Keep in step with CATEGORIES in js/store.js. `words` guess the problem from a plain email.
var CATEGORIES = [
  { id: 'where', label: "I can't find where to order", words: /where (do|can|to)|how (do|can) i order|link|website|can'?t find/i },
  { id: 'payment', label: "My payment didn't go through", words: /declin|payment|card|charge|pay /i },
  { id: 'confirm', label: 'I paid but never got a confirmation', words: /confirmation|receipt|never (got|received)|no email/i },
  { id: 'unsure', label: "I'm not sure if I already ordered", words: /already order|did i order|not sure (if|whether)/i },
  { id: 'name', label: 'Fix a name or personalization', words: /spell|personali[sz]|misspel|wrong name|name (is|was) wrong/i },
  { id: 'change', label: 'Change or cancel my order', words: /cancel|refund|change (my|the|our) order/i },
  { id: 'cost', label: 'Price, deadline or help paying', words: /price|cost|how much|deadline|afford|financial|scholarship/i },
  { id: 'other', label: 'Something else', words: null }
];

/* Run this once by hand: it asks for permission and starts the five-minute timer. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkMail') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkMail').timeBased().everyMinutes(5).create();
  // Start from now: mail already sitting in the group is not turned into tickets.
  if (!prop('LAST_RUN')) PropertiesService.getScriptProperties().setProperty('LAST_RUN', String(Date.now()));
  checkMail();
}

function prop(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || DEFAULTS[name] || '';
}

function checkMail() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;   // the last run is still going
  try {
    var started = Date.now();
    var since = Number(prop('LAST_RUN')) || started - 60 * 60 * 1000;
    var mail = collectMail(since);
    if (mail.length) saveWithRetry(mail);
    PropertiesService.getScriptProperties().setProperty('LAST_RUN', String(started));
  } finally {
    lock.releaseLock();
  }
}

/* ---------- reading the mail ---------- */

function collectMail(since) {
  var group = prop('GROUP').toLowerCase();
  var me = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  // Look back ten minutes past the last run; anything seen twice is recognised by its id.
  var after = Math.floor((since - 10 * 60 * 1000) / 1000);
  var query = '{to:' + group + ' cc:' + group + ' list:' + group.replace('@', '.') + '} after:' + after;
  var out = [];
  GmailApp.search(query, 0, 50).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      if (msg.getDate().getTime() < after * 1000) return;
      if (isAutomatic(msg)) return;
      var from = senderOf(msg, group);
      if (!from.email || from.email === group || from.email === me) return;
      out.push({
        id: msg.getId(), thread: thread.getId(), at: msg.getDate().toISOString(),
        email: from.email, name: from.name, subject: String(msg.getSubject() || '').trim(),
        body: cleanBody(msg.getPlainBody())
      });
    });
  });
  out.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
  return out;
}

function isAutomatic(msg) {
  var auto = String(msg.getHeader('Auto-Submitted') || '').toLowerCase();
  var prec = String(msg.getHeader('Precedence') || '').toLowerCase();
  var from = String(msg.getFrom() || '').toLowerCase();
  return (auto && auto !== 'no') || prec === 'auto_reply' || prec === 'junk'
    || /mailer-daemon|postmaster|no-?reply/.test(from);
}

/* Google Groups sometimes rewrites From to "'Name' via Group <group@…>"; the real
   sender is then in X-Original-Sender or Reply-To. */
function senderOf(msg, group) {
  var from = parseAddress(msg.getFrom());
  if (from.email === group) {
    var real = parseAddress(msg.getHeader('X-Original-Sender') || msg.getReplyTo() || '');
    if (real.email && real.email !== group) from.email = real.email;
  }
  from.name = from.name.replace(/\s+via\s+.*$/i, '').replace(/^['"]|['"]$/g, '').trim() || from.email.split('@')[0];
  return from;
}

function parseAddress(text) {
  text = String(text || '');
  var m = text.match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+/);
  var name = text.replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  return { email: m ? m[0].toLowerCase() : '', name: name.indexOf('@') < 0 ? name : '' };
}

/* Drop the quoted earlier messages, signatures and the Google Groups footer. */
function cleanBody(text) {
  var lines = String(text || '').replace(/\r/g, '').split('\n'), keep = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^On .{5,200} wrote:\s*$/.test(line) || /^-- ?$/.test(line) || /^-{2,}\s*Forwarded message/i.test(line)
      || /^You received this message because you are subscribed to the Google Groups/.test(line)) break;
    if (/^>/.test(line)) continue;
    keep.push(line);
  }
  return keep.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);
}

/* ---------- turning mail into tickets ---------- */

function isIgnored(email, list) {
  return (list || []).some(function (entry) {
    entry = String(entry || '').trim().toLowerCase();
    if (!entry) return false;
    return entry.charAt(0) === '@' ? email.slice(-entry.length) === entry : email === entry;
  });
}

function newCode(data) {
  for (;;) {
    var code = 'YB-';
    for (var i = 0; i < 4; i++) code += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    if (!data.tickets.some(function (t) { return t.id === code; })) return code;
  }
}

/* The help page's own email (sent from a device that isn't a station) has labelled lines. */
function readForm(body) {
  var get = function (label) { var m = body.match(new RegExp('^' + label + ': (.+)$', 'm')); return m ? m[1].trim() : ''; };
  var student = get('Student'), grade = '';
  var g = student.match(/^(.*) \(([^)]*)\)$/);
  if (g) { student = g[1]; grade = g[2]; }
  var problem = get('Problem'), category = '';
  CATEGORIES.forEach(function (c) { if (c.label === problem) category = c.id; });
  if (!student || !category) return null;
  var parts = body.split('\n\n');
  return { name: student, grade: grade, who: get('From'), category: category, orderRef: get('Order number'), details: parts.slice(1).join('\n\n').trim() || body };
}

function guessCategory(text) {
  for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].words && CATEGORIES[i].words.test(text)) return CATEGORIES[i].id;
  return 'other';
}

/* Adds the mail to the data. Safe to run twice on the same mail: ids already filed are skipped.
   Returns how many messages changed something. */
function applyMail(data, mail) {
  var ignore = (data.settings && data.settings.ignoreSenders) || [];
  var known = {};
  data.tickets.forEach(function (t) {
    if (t.mailId) known[t.mailId] = true;
    (t.notes || []).forEach(function (n) { if (n.mailId) known[n.mailId] = true; });
  });
  var changed = 0;
  mail.forEach(function (m) {
    if (known[m.id] || isIgnored(m.email, ignore)) return;
    // The staff desk's own update emails are copied to the group; they are already notes.
    if (/^Yearbook order help: update on ticket/i.test(m.subject)) return;
    var code = (m.subject.toUpperCase().match(/\bYB-[A-Z0-9]{4}\b/) || [])[0];
    var ticket = null;
    data.tickets.forEach(function (t) { if ((code && t.id === code) || (!code && t.mailThread === m.thread)) ticket = ticket || t; });
    if (ticket) {
      ticket.notes = ticket.notes || [];
      ticket.notes.push({ id: 'mail-' + m.id, at: m.at, by: m.name + ' (email)', text: m.body || m.subject, shared: false, mailId: m.id });
      if (ticket.status === 'waiting') ticket.status = 'working';
      ticket.updatedAt = new Date().toISOString();
    } else {
      var form = readForm(m.body);
      data.tickets.push({
        id: newCode(data), createdAt: m.at, updatedAt: m.at,
        name: form ? form.name : m.name, grade: form ? form.grade : '', who: form ? form.who : '',
        contact: m.email,
        category: form ? form.category : guessCategory(m.subject + '\n' + m.body),
        details: form ? form.details : (m.subject ? m.subject + '\n\n' : '') + m.body,
        orderRef: form ? form.orderRef : '',
        status: 'new', assignee: '', urgent: false, source: 'email', notes: [],
        mailId: m.id, mailThread: m.thread
      });
    }
    known[m.id] = true;
    changed++;
  });
  return changed;
}

/* ---------- GitHub ---------- */

function github(method, body) {
  var res = UrlFetchApp.fetch(DEFAULTS.API + '/repos/' + prop('DATA_REPO') + '/contents/' + PATH, {
    method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop('GITHUB_TOKEN'), Accept: 'application/vnd.github+json' },
    payload: body ? JSON.stringify(body) : undefined
  });
  return { code: res.getResponseCode(), text: res.getContentText() };
}

/* One ticket per line, the same layout js/sync.js writes. */
function serialize(data) {
  var t = data.tickets;
  return '{\n"settings": ' + JSON.stringify(data.settings) + ',\n"tickets": ['
    + (t.length ? '\n  ' + t.map(function (x) { return JSON.stringify(x); }).join(',\n  ') + '\n' : '') + ']\n}\n';
}

function saveWithRetry(mail) {
  for (var attempt = 0; attempt < 4; attempt++) {
    var got = github('get');
    var sha = null, data = { settings: { staff: [] }, tickets: [] };
    if (got.code === 200) {
      var meta = JSON.parse(got.text);
      sha = meta.sha;
      var text = Utilities.newBlob(Utilities.base64Decode(String(meta.content).replace(/\s/g, ''))).getDataAsString();
      if (text.trim()) data = JSON.parse(text);
      data.settings = data.settings || { staff: [] };
      data.tickets = data.tickets || [];
    } else if (got.code !== 404) {
      throw new Error('GitHub read failed (' + got.code + '): ' + got.text.slice(0, 200));
    }
    if (!applyMail(data, mail)) return;
    var body = { message: 'Email: update ' + PATH, content: Utilities.base64Encode(serialize(data), Utilities.Charset.UTF_8) };
    if (sha) body.sha = sha;
    var put = github('put', body);
    if (put.code === 200 || put.code === 201) return;
    // 409/422: a station or desk saved in between. Fetch again and re-apply.
    if (put.code !== 409 && put.code !== 422) throw new Error('GitHub write failed (' + put.code + '): ' + put.text.slice(0, 200));
  }
  throw new Error('Could not save: the file kept changing. Will try again on the next run.');
}
