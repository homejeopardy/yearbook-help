/* Runs apps-script/Code.gs outside Google, with stand-ins for Gmail and GitHub.
   node dev/test_mail_intake.js */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto'), assert = require('assert');

const GROUP = 'bpcyearbook@blackpinecircle.org';
const now = Date.now();
const props = { GITHUB_TOKEN: 'test-key', LAST_RUN: String(now - 30 * 60 * 1000) };
let file = null, puts = 0, conflictOnce = false, threads = [];

const msg = (id, from, subject, body, minsAgo, headers) => ({
  getId: () => id, getFrom: () => from, getReplyTo: () => (headers || {})['Reply-To'] || '',
  getSubject: () => subject, getPlainBody: () => body, getDate: () => new Date(now - (minsAgo || 1) * 60000),
  getHeader: h => (headers || {})[h] || ''
});
const thread = (id, msgs) => ({ getId: () => id, getMessages: () => msgs });
const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const reply = (code, obj) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(obj || {}) });

const sandbox = {
  console,
  Session: { getActiveUser: () => ({ getEmail: () => 'nathan@blackpinecircle.org' }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  ScriptApp: {},
  GmailApp: { search: q => { sandbox.lastQuery = q; return threads; } },
  Utilities: {
    Charset: { UTF_8: 'utf8' },
    base64Encode: s => Buffer.from(s, 'utf8').toString('base64'),
    base64Decode: b => Buffer.from(b, 'base64'),
    newBlob: buf => ({ getDataAsString: () => buf.toString('utf8') })
  },
  UrlFetchApp: {
    fetch: (url, o) => {
      assert.ok(url.endsWith('/repos/homejeopardy/yearbook-help-data/contents/tickets.json'), url);
      assert.strictEqual(o.headers.Authorization, 'Bearer test-key');
      if (o.method === 'get') return file == null ? reply(404) : reply(200, { sha: sha(file), content: Buffer.from(file).toString('base64') });
      const body = JSON.parse(o.payload);
      if (conflictOnce) {       // a desk saves in between: the write must be refused, then redone on top
        conflictOnce = false;
        const d = JSON.parse(file); d.settings.staff.push('Priya'); file = JSON.stringify(d);
        return reply(409);
      }
      if (file != null && body.sha !== sha(file)) return reply(409);
      file = Buffer.from(body.content, 'base64').toString('utf8'); puts++;
      return reply(file ? 200 : 201, { content: { sha: sha(file) } });
    }
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), sandbox);
const data = () => JSON.parse(file);

// 1. A plain email becomes a ticket; the whitelist, the script's own account and auto-replies do not.
file = JSON.stringify({ settings: { staff: ['Nathan'], ignoreSenders: ['Adviser@BlackPineCircle.org', '@yearbookvendor.example'] }, tickets: [] });
threads = [
  thread('t1', [msg('m1', 'Dana Lee <dana@example.test>', 'Card declined', 'Hi,\nMy card was declined twice — é.\n\nOn Mon, Oct 1, 2026 at 9:00 AM Someone <x@y.z> wrote:\n> old', 5)]),
  thread('t2', [msg('m2', 'Ms. Adviser <adviser@blackpinecircle.org>', 'FYI', 'staff chatter', 4)]),
  thread('t3', [msg('m3', 'rep@yearbookvendor.example', 'Invoice', 'vendor', 4)]),
  thread('t4', [msg('m4', 'Nathan <nathan@blackpinecircle.org>', 'note to self', 'me', 3)]),
  thread('t5', [msg('m5', 'Out <ooo@example.test>', 'Out of office', 'away', 3, { 'Auto-Submitted': 'auto-replied' })]),
  thread('t6', [msg('m6', "'Raj P' via BPC Yearbook <" + GROUP + '>', 'where do i order', 'Cannot find the link', 2, { 'X-Original-Sender': 'raj@example.test' })]),
  thread('t7', [msg('m7', 'Kim <kim@example.test>', 'Yearbook order help: Fix a name or personalization',
    'Student: Ana Kim (6B)\nFrom: Parent or guardian\nProblem: Fix a name or personalization\nOrder number: 771\n\nName is spelled Anna on the order.', 1)])
];
sandbox.checkMail();
let t = data().tickets;
assert.deepStrictEqual(t.map(x => x.contact), ['dana@example.test', 'raj@example.test', 'kim@example.test']);
assert.strictEqual(t[0].name, 'Dana Lee'); assert.strictEqual(t[0].category, 'payment'); assert.strictEqual(t[0].source, 'email');
assert.strictEqual(t[0].details, 'Card declined\n\nHi,\nMy card was declined twice — é.');
assert.strictEqual(t[1].name, 'Raj P'); assert.strictEqual(t[1].category, 'where');
assert.deepStrictEqual([t[2].name, t[2].grade, t[2].who, t[2].category, t[2].orderRef, t[2].details],
  ['Ana Kim', '6B', 'Parent or guardian', 'name', '771', 'Name is spelled Anna on the order.']);
assert.ok(t.every(x => /^YB-[A-Z2-9]{4}$/.test(x.id)));
assert.ok(sandbox.lastQuery.includes('to:' + GROUP) && sandbox.lastQuery.includes('list:bpcyearbook.blackpinecircle.org'));
assert.strictEqual(puts, 1);
assert.ok(file.split('\n').length === 3 + 3 + 3, 'one ticket per line');

// 2. Running again over the same mail changes nothing.
sandbox.checkMail();
assert.strictEqual(puts, 1); assert.strictEqual(data().tickets.length, 3);

// 3. Replies join their ticket (same thread, or the code in the subject); "waiting" moves on.
const d = data(); d.tickets[0].status = 'waiting'; file = JSON.stringify(d);
const danaCode = d.tickets[0].id, rajCode = d.tickets[1].id;
threads = [
  thread('t1', [threads[0].getMessages()[0], msg('m8', 'Dana Lee <dana@example.test>', 'Re: Card declined', 'Tried again, worked!', 1)]),
  thread('t9', [msg('m9', 'raj@example.test', 'Re: Yearbook order help: update on ticket ' + rajCode.toLowerCase(), 'thanks', 1)]),
  thread('t9b', [msg('m10', 'unlisted.staff@blackpinecircle.org', 'Yearbook order help: update on ticket ' + rajCode, 'our own update', 1)])
];
conflictOnce = true;
sandbox.checkMail();
t = data().tickets;
assert.strictEqual(t.length, 3);
assert.deepStrictEqual(t[0].notes.map(n => [n.by, n.text, n.shared]), [['Dana Lee (email)', 'Tried again, worked!', false]]);
assert.strictEqual(t[0].status, 'working'); assert.strictEqual(t[0].id, danaCode);
assert.deepStrictEqual(t[1].notes.map(n => n.text), ['thanks']);
assert.deepStrictEqual(data().settings.staff, ['Nathan', 'Priya'], 'the desk change made mid-save survives');

// 4. No file yet: the first email creates it.
file = null; threads = [thread('ta', [msg('mb', 'new@example.test', '', 'help', 1)])];
sandbox.checkMail();
assert.strictEqual(data().tickets[0].name, 'new'); assert.strictEqual(data().tickets[0].details, 'help');

console.log('mail intake: all checks passed');
