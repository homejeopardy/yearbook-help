/* ---------------------------------------------------------------
   Things you may want to change. The app itself is public; the
   tickets (names and how to reach people) go in a separate, PRIVATE
   repository. Change dataRepo if you name it differently.
   --------------------------------------------------------------- */
const CONFIG = {
  title: 'Yearbook Order Help',
  // Where a yearbook is actually ordered. Shown as a link on the help page; leave '' to hide it.
  orderUrl: '',
  // The yearbook staff's shared address — the school Google Group. People are told they can
  // write to it, a device that isn't a set-up help station sends its request there as an
  // email, and it is copied on every update staff send. Leave '' to turn all of that off.
  // Mail to the group becomes tickets through apps-script/Code.gs (see the README).
  helpEmail: 'bpcyearbook@blackpinecircle.org',
  // How the staff desk opens an update email: 'gmail' (a Gmail compose tab, for school Google
  // accounts) or 'mailto' (whatever mail app the computer uses).
  mailVia: 'gmail',
  signature: 'BPC Yearbook Staff',
  dataRepo: 'homejeopardy/yearbook-help-data',
  // PUBLIC repository holding accounts.json: each staff account's password-locked copy of
  // the access key (see js/accounts.js). Nothing in it is readable without a password.
  accountsRepo: 'homejeopardy/yearbook-help-accounts',
  apiBase: 'https://api.github.com',
  pollSeconds: 20
};

// Local testing only: point sync at a stand-in for GitHub (see dev/mock_github_api.py).
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  try { CONFIG.apiBase = localStorage.getItem('yearbook-help-dev-api') || CONFIG.apiBase; } catch (e) { /* ignore */ }
}
