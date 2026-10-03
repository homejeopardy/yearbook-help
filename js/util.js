/* Small helpers shared by both pages. */

const $ = (sel, root) => (root || document).querySelector(sel);

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/* "3 h", "2 d" — how long a ticket has been sitting. */
function age(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return mins + ' min';
  if (mins < 60 * 24) return Math.round(mins / 60) + ' h';
  return Math.round(mins / 1440) + ' d';
}

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) {
  try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ }
}

/* A link that opens a ready-written email: a Gmail compose tab, or the computer's mail app. */
function mailLink(m, via) {
  const q = (pairs) => pairs.filter(p => p[1]).map(p => p[0] + '=' + encodeURIComponent(p[1])).join('&');
  if (via === 'gmail') return 'https://mail.google.com/mail/?view=cm&fs=1&' + q([['to', m.to], ['cc', m.cc], ['su', m.subject], ['body', m.body]]);
  return 'mailto:' + (m.to || '') + '?' + q([['cc', m.cc], ['subject', m.subject], ['body', m.body]]);
}

function renderSyncPill(el) {
  const d = Sync.describe();
  el.className = 'pill pill-' + d.tone;
  el.textContent = d.text;
  el.title = Sync.status().detail || '';
  el.hidden = !d.text;
}
