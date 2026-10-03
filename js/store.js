/* ---------------------------------------------------------------
   The tickets themselves, and every rule about them. Both pages —
   the help station and the staff desk — go through this file, and
   js/sync.js keeps the copy in this browser in step with GitHub.
   --------------------------------------------------------------- */

const STORE_KEY = 'yearbook-help-db';

const CATEGORIES = [
  { id: 'where', label: "I can't find where to order" },
  { id: 'payment', label: "My payment didn't go through" },
  { id: 'confirm', label: 'I paid but never got a confirmation' },
  { id: 'unsure', label: "I'm not sure if I already ordered" },
  { id: 'name', label: 'Fix a name or personalization' },
  { id: 'change', label: 'Change or cancel my order' },
  { id: 'cost', label: 'Price, deadline or help paying' },
  { id: 'other', label: 'Something else' }
];

const STATUSES = [
  { id: 'new', label: 'New', forStudent: "We've got your request. Someone on yearbook staff will pick it up soon." },
  { id: 'working', label: 'In progress', forStudent: 'Someone on yearbook staff is working on this now.' },
  { id: 'waiting', label: 'Waiting on you', forStudent: 'We need something from you before we can finish. See the message below, or stop by the yearbook room.' },
  { id: 'resolved', label: 'Resolved', forStudent: 'This one is done.' }
];

const WHO = ['Student', 'Parent or guardian', 'Teacher or staff'];

// No I, L, O, 0 or 1: a ticket code gets read off a screen and typed back in.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let DB = loadDB();

function migrate(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    tickets: Array.isArray(d.tickets) ? d.tickets : [],
    settings: Object.assign({ staff: [], ignoreSenders: [] }, d.settings || {})
  };
}

function loadDB() {
  try { return migrate(JSON.parse(localStorage.getItem(STORE_KEY))); } catch (e) { return migrate(null); }
}

function persistQuietly() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) { /* private mode */ }
}

function persist() {
  persistQuietly();
  window.dispatchEvent(new Event('tickets:changed'));
}

const labelOf = (list, id) => (list.find(x => x.id === id) || { label: id || '' }).label;
const isOpen = t => t.status !== 'resolved';
const getTicket = id => DB.tickets.find(t => t.id === id);

function newCode() {
  for (;;) {
    const pick = new Uint32Array(4);
    crypto.getRandomValues(pick);
    const code = 'YB-' + Array.from(pick, n => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
    if (!getTicket(code)) return code;
  }
}

/* What someone types back in: "yb 4k7q", "4K7Q" and "YB-4K7Q" are all the same ticket. */
function normalizeCode(text) {
  const s = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^YB/, '');
  return s ? 'YB-' + s : '';
}

function buildTicket(fields, source) {
  const now = new Date().toISOString();
  const clean = k => String(fields[k] || '').trim();
  return {
    id: newCode(),
    createdAt: now,
    updatedAt: now,
    name: clean('name'),
    grade: clean('grade'),
    who: clean('who') || WHO[0],
    contact: clean('contact'),
    category: clean('category') || 'other',
    details: clean('details'),
    orderRef: clean('orderRef'),
    status: 'new',
    assignee: '',
    urgent: false,
    source: source,          // 'station', 'desk'
    notes: []
  };
}

function createTicket(fields, source) {
  const t = buildTicket(fields, source);
  DB.tickets.push(t);
  persist();
  return t;
}

function updateTicket(id, patch) {
  const t = getTicket(id);
  if (!t) return null;
  Object.assign(t, patch);
  t.updatedAt = new Date().toISOString();
  if ('status' in patch) t.resolvedAt = patch.status === 'resolved' ? t.updatedAt : '';
  persist();
  return t;
}

/* shared = the person who asked sees it when they look their ticket up. */
function addNote(id, text, by, shared) {
  const t = getTicket(id);
  text = String(text || '').trim();
  if (!t || !text) return null;
  t.notes.push({ id: uid(), at: new Date().toISOString(), by: by || 'Staff', text: text, shared: !!shared });
  t.updatedAt = new Date().toISOString();
  persist();
  return t;
}

function deleteTicket(id) {
  DB.tickets = DB.tickets.filter(t => t.id !== id);
  persist();
}

function saveSettings(patch) {
  Object.assign(DB.settings, patch);
  persist();
}

/* The address updates go to, if the person left one. */
function emailOf(t) {
  const m = String((t && t.contact) || '').match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+\.[A-Za-z]{2,}/);
  return m ? m[0] : '';
}

/* The email that tells someone their ticket changed. message is what staff just wrote
   for them; without one, the last message they were shown is repeated. */
function updateEmail(t, message) {
  const st = STATUSES.find(s => s.id === t.status) || STATUSES[0];
  const shared = t.notes.filter(n => n.shared);
  message = message || (shared.length ? shared[shared.length - 1].text : '');
  const first = t.who === WHO[0] ? t.name.trim().split(/\s+/)[0] : '';
  return {
    to: emailOf(t),
    cc: CONFIG.helpEmail,
    subject: 'Yearbook order help: update on ticket ' + t.id,
    body: [
      'Hi' + (first ? ' ' + first : '') + ',',
      '',
      'Your yearbook order help request for ' + t.name + ' (' + labelOf(CATEGORIES, t.category) + ') was updated.',
      '',
      'Status: ' + st.label + '. ' + st.forStudent,
      message ? '\n' + message + '\n' : '',
      'Ticket code: ' + t.id,
      'Questions? Reply to this email' + (CONFIG.helpEmail ? ' or write to ' + CONFIG.helpEmail : '') + '.',
      '',
      CONFIG.signature
    ].join('\n')
  };
}

function ticketsToCSV() {
  const cols = ['id', 'createdAt', 'status', 'assignee', 'urgent', 'name', 'grade', 'who', 'contact', 'category', 'orderRef', 'details', 'resolvedAt'];
  const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = DB.tickets.map(t => cols.map(c => cell(c === 'category' ? labelOf(CATEGORIES, t.category) : c === 'status' ? labelOf(STATUSES, t.status) : t[c])).join(','));
  return [cols.join(',')].concat(rows).join('\r\n') + '\r\n';
}
