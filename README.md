# Yearbook Order Help

A small ticketing system for people who get stuck ordering a yearbook.

- **Help station** (`/`): someone says what went wrong and gets a ticket code like `YB-4K7Q`.
  They can type the code back in later to see where things stand and read any message staff left for them.
- **Staff desk** (`/desk/`): the queue. Pick a ticket up, assign it, mark it urgent, add notes
  (private, or shown to the person who asked), and resolve it. Staff can also enter a ticket
  themselves for a walk-up, an email or a phone call.

It is a static site: plain HTML, CSS and JavaScript, no build step and no server.

## Where the tickets live

Tickets hold names and contact details, so they are **not** in this repository. They are kept in
one file, `tickets.json`, in a separate **private** repository (`homejeopardy/yearbook-help-data`
unless you change `dataRepo` in `js/config.js`). Each device keeps its own working copy and
syncs with that file every 20 seconds and after every change.

## Setting it up

1. On GitHub, create three repositories:
   - `yearbook-help` (public): this code. Turn on GitHub Pages for the `main` branch.
   - `yearbook-help-data` (**private**, empty): the tickets.
   - `yearbook-help-accounts` (public, empty): the staff accounts file.
2. Create a fine-grained personal access token: *Only select repositories* →
   `yearbook-help-data` **and** `yearbook-help-accounts`, *Repository permissions* →
   *Contents: Read and write*. This is the **access key**.
3. On one computer, open `/desk/` → **Set up with an access key** → paste it. This is the only
   time anyone pastes it. Type your name and pick a password: that makes the first account.
4. In **Settings**, add the rest of the yearbook staff's names.

## Staff accounts

Staff sign in at `/desk/` with their **name** (as it is on the staff list) and a **password**.

- **First time:** on a computer that is already connected (yours, or any computer where someone
  has signed in before), they type their name and are asked to pick a password. Signing out
  leaves a computer connected, so a classroom computer works for this all year.
- **After that:** name and password work on any computer, which connects itself. Nobody pastes a key.
- **Help station:** open `/` → *Station setup* and sign in with a staff name and password.
- **Forgot a password:** Settings → *Reset password* next to their name; they pick a new one
  the next time they sign in on a connected computer.
- **Someone leaves:** delete their name in Settings. Their account goes too.

How it works, and its limits: the access key can't be written into the site itself — the site
is public, so anyone could read every ticket with it, and GitHub cancels keys it finds in public
repositories. Instead each account stores its own copy of the key, locked with that person's
password, in `accounts.json` in the public accounts repository (`js/accounts.js`). Without a
password the file is useless, but because it is public a short or guessable password can be
guessed by someone determined, so passwords must be at least eight characters. The sign-in
screen on an already-connected computer keeps classmates out of the queue; it is not what
protects the data — that is the key never reaching a computer without a password.

If the key is ever replaced: disconnect one computer (Settings), set it up with the new key,
and sign in there. Everyone else signs in once on a connected computer and their account
picks up the new key.

## Email

- **Updates to the person who asked.** The form asks for an email address. On the staff desk,
  ticking *Show this to them* turns the button into **Add note and email them**: the note is
  saved and an email to that person opens, already written, with the staff group copied. You
  press Send. A page like this has no server, so it cannot send mail by itself.
  *Email them where this stands* does the same for a status change with no new note.
  `mailVia` in `js/config.js` picks Gmail (the default) or the computer's own mail app.
- **Writing to yearbook staff.** Put the school Google Group's address in `helpEmail` in
  `js/config.js`. It is then shown on the help page and on every ticket, and copied on updates.
  For people outside the school to reach it, the group has to allow posts from anyone
  (Group settings → *Who can post*); a school admin may need to change that.

## Tickets from email

Anyone can write to **bpcyearbook@blackpinecircle.org**. A small script, `apps-script/Code.gs`,
checks that mail every five minutes and files each new email as a ticket — name and address
from the sender, the email as the details, and a best guess at the kind of problem.

- **Who doesn't get a ticket:** senders listed in the staff desk under Settings → Email
  (*Don't make tickets from these senders*: an address, or `@domain`), the account the script
  runs in, and automatic replies. Put the yearbook staff, the adviser and the yearbook company there.
- **Replies** to a ticket's email thread, or any email with the ticket code in its subject, are
  added to that ticket as a note. A ticket that was *Waiting on them* goes back to *In progress*.
- The script only reads mail and writes tickets. It never sends, deletes or changes an email.

Setting it up, once, signed in to a school Google account that is a member of the group and
gets each of its emails:

1. Go to script.google.com → **New project**. Delete what's there and paste in all of
   `apps-script/Code.gs`.
2. **Project Settings → Script properties → Add**: `GITHUB_TOKEN` = the access key
   (this is the one other place it is pasted).
3. Back in the editor, choose the function **setup** and press **Run**. Approve the permissions
   (read Gmail, connect to GitHub). From then on it runs by itself; mail that arrived before
   this moment is left alone.

If the school has turned Apps Script off for your account, step 1 will say so — ask the
adviser or IT to run it from theirs. Failures show under **Executions** in the script editor.
`node dev/test_mail_intake.js` tests the script without Google.

## What it can't do

Only a device with the access key can save a ticket from the form. The key can't be put in the
public page (anyone could read every ticket with it), so on any other device the form writes
the request as an email to the group instead — which becomes a ticket once the email script
above is running.

The station device holds a copy of every ticket in its browser storage, even though the page
only ever shows a ticket to someone who types its code. Use a device the yearbook staff control.

The form tells people never to type a card number or password, and no field asks for one.

## Changing things

- `js/config.js`: the title, the link to the real order page (`orderUrl`), `helpEmail`, the data repository.
- `js/store.js`: the list of problems people can choose (`CATEGORIES`) and the wording of each status.
- `styles.css`: the colours and fonts (taken from blackpinecircle.org) are the variables at the top.

After changing a `.js` or `.css` file, bump the `?v=5` numbers in both `index.html` files so
browsers don't pair an old script with the new page.

## Testing sync without GitHub

    python3 dev/mock_github_api.py 8789
    python3 -m http.server 8791

In the browser console on `http://localhost:8791`, run
`localStorage['yearbook-help-dev-api'] = 'http://localhost:8789'`, reload, and connect with the
key `test-key`. `http://127.0.0.1:8791` has separate storage, so it acts as a second device.
