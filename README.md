# Trexpanda — Type Less. Do More.

A cross-platform (Windows + macOS) desktop text expander with **team-shared
snippet libraries**. Type a short trigger like `;addr` and it expands to a full
snippet. Teams keep a shared library that everyone syncs to, so when the owner
updates a snippet, everyone gets it.

This is a working **MVP (v0.1)**. Text expansion + team sync are built and
tested. Macro/click recording is scoped as the next phase — see the roadmap at
the bottom.

---

## What it does today

- **Text expansion** — global, works in any app. Triggers expand via a fast
  backspace-then-paste technique (reliable across apps and keyboard layouts).
- **Snippet manager** — add / edit / delete your personal snippets in a clean UI.
- **Dynamic tokens** — `{date}`, `{time}`, `{datetime}`, and `$|` to place the
  cursor after expansion.
- **Team library sync** — point everyone at one shared source (a URL or a synced
  folder). The app pulls updates on an interval or on demand. No backend server
  required.
- **Conflict control** — choose whether your local snippet or the team snippet
  wins when triggers collide.
- **Publish** — a team owner can push their snippets to a shared folder from
  inside the app.
- **Lives in the tray/menubar**, optional launch-at-login, master on/off switch.

---

## Run it in development

You need [Node.js](https://nodejs.org) 18+ installed.

```bash
cd text-expander
npm install        # installs Electron + native modules
npm start          # launches the app
```

Run the logic tests any time (no GUI needed):

```bash
npm test           # 15 unit tests: expansion engine + sync/merge
```

---

## Build installers (the downloadable app)

The app packages with [electron-builder](https://www.electron.build).

```bash
npm run dist:win   # -> release/Trexpanda Setup 0.1.0.exe   (Windows installer)
npm run dist:mac   # -> release/Trexpanda-0.1.0.dmg         (macOS disk image)
```

> Build Windows installers on Windows and macOS installers on macOS (or use a
> CI runner per platform). Cross-building macOS from Windows/Linux is not
> supported by Apple's toolchain.

The output installers in `release/` are what your team downloads and installs.

---

## Get the installers automatically (GitHub Actions) — no Node, no terminal

A workflow at `.github/workflows/build.yml` builds **both** the Windows `.exe`
and the macOS `.dmg` for you in the cloud, so you don't need to install anything
or own a Mac.

1. Put this project in a **GitHub repository** (GitHub Desktop is the easiest way
   if you don't use git on the command line: *File → Add Local Repository →*
   pick the extracted `text-expander` folder → *Publish*).
2. On GitHub, open the **Actions** tab → select **"Build Trexpanda installers"**
   → click **Run workflow**. (It also runs automatically whenever you push a tag
   like `v0.1.0`.)
3. When the run finishes (a few minutes), open it and scroll to **Artifacts** at
   the bottom. Download **`trexpanda-win`** (contains the `.exe`) and
   **`trexpanda-mac`** (contains the `.dmg`). Those are the files your team
   installs.

The workflow runs the test suite first, so a broken build won't ship.

---

## First-run permissions

**macOS** requires two permissions for any text expander (this is an OS rule,
not specific to this app). On first run, macOS will prompt — or grant manually
in **System Settings → Privacy & Security**:

- **Accessibility** — to detect typing and insert snippets.
- **Input Monitoring** — to read the global key stream.

After granting, quit and reopen the app. The app's status bar shows a red
"hook missing / inject missing" pill until permissions are granted.

**Windows** needs no special permission. If a target app runs **as
Administrator**, run the expander as Administrator too, or it can't send keys
into that window.

---

## Team sync — how it works

The "team library" is just a JSON file that one owner maintains and everyone
else reads. There's no server to run. Two ways to host it:

### Option A — Shared folder (simplest; recommended to start)

Put `team-library.json` in a folder that syncs to everyone: Dropbox, Google
Drive, OneDrive, or a network share.

- **Owner:** Settings → *Publish* → choose the shared folder → *Publish my
  snippets*. (Or hand-edit `team-library.json`.)
- **Everyone else:** Settings → *Team library source* → paste the folder path
  (e.g. `/Users/you/Dropbox/Team` or `C:\Users\you\OneDrive\Team`) → Save →
  *Sync now*.

### Option B — Git / URL (best for versioning)

Keep `team-library.json` in a git repo. Each teammate sets the source to the
**raw** URL, e.g.
`https://raw.githubusercontent.com/your-org/snippets/main/team-library.json`.
Any HTTP(S) endpoint (S3, CDN, internal server) works too. Updates are pulled on
the sync interval.

> Which to pick? If your team already shares a Dropbox/Drive folder, use Option
> A — nothing new to set up. If your team is technical and wants history/review
> on snippet changes, use Option B. You asked to decide later; you can switch at
> any time by changing the source field.

### Library format

```json
{
  "version": 3,
  "snippets": [
    { "trigger": ";addr", "replacement": "123 Market St", "label": "Address" }
  ]
}
```

A bare `[ ... ]` array of snippets is also accepted. A sample lives in
`team-library/team-library.json`.

---

## Accounts, friends & sharing (optional)

Beyond the file-based team library, Trexpanda can connect people directly: sign
in (email/password or **Google**), add friends/coworkers by username, and
**share your snippet library** with specific people. When you share, they receive your snippets — and your future
updates — in their own app; when they share with you, you can pull their
snippets into your expander with one click.

This runs on [Supabase](https://supabase.com) (hosted Postgres + auth) — no
server of your own to run, free tier is plenty. It's entirely optional: without
a Supabase project configured, the app works exactly as before and the
**Friends & Sharing** tab shows a short "not set up" notice.

Setup takes ~5 minutes — see **[CLOUD_SETUP.md](CLOUD_SETUP.md)**. In short:
create a Supabase project, run [`supabase/schema.sql`](supabase/schema.sql), and
drop your project URL + anon key into `src/cloud/cloud-config.json` (or the
`SUPABASE_URL` / `SUPABASE_ANON_KEY` env vars).

Your snippets stay private until you explicitly turn on **Share** for a friend.
All cloud code lives in `src/cloud/` and runs in the main process; the renderer
reaches it only through the existing preload bridge.

---

## Auto-updates (optional)

The app is wired for [electron-updater](https://www.electron.build/auto-update).
To turn it on:

1. In `package.json` → `build.publish`, set your GitHub `owner`/`repo` (or another
   provider).
2. Code-sign the app (required for updates: an Apple Developer ID on macOS, an
   Authenticode certificate on Windows).
3. `electron-builder` publishes releases; installed apps then update themselves.

Until configured, the updater is a no-op and does no harm.

---

## Project layout

```
src/
  expander.js   Pure expansion engine (trigger matching, tokens, caret) — unit-tested
  store.js      Personal + team + cloud snippet storage and merge logic — unit-tested
  sync.js       Team-library fetch (URL or folder) and publish — unit-tested
  keymap.js     uiohook keycode -> character (US layout)
  inject.js     Keystroke output: backspaces + clipboard paste (nut-js)
  main.js       Electron main process: tray, global hook, wiring, IPC, sync scheduler
  preload.js    Secure bridge to the renderer
  cloud/        Optional Supabase layer: accounts, friends, library sharing
    config.js     Resolves the Supabase URL + anon key (env or cloud-config.json)
    client.js     Lazy Supabase client with an electron-store session adapter
    helpers.js    Pure friend/snippet helpers — unit-tested
    index.js      CloudService: auth, friends, libraries, shares (main process)
  renderer/     Snippet manager UI (index.html + renderer.js)
test/           Node unit tests (npm test)
team-library/   Sample shared library
supabase/       schema.sql — tables + Row Level Security for the cloud features
```

Native modules: `uiohook-napi` (global key capture) and
`@nut-tree-fork/nut-js` (key injection). `npm install` fetches prebuilt binaries
for Windows/macOS; the app degrades gracefully to a manager-only mode and shows
a clear banner if either fails to load on a given machine.

---

## Known limitations (MVP)

- **Keyboard layout:** character detection uses a US-QWERTY map. Non-US layouts
  may mis-read some punctuation triggers. The fix is to read characters from the
  OS layout API — planned.
- **Rich text:** snippets are plain text. No formatted/HTML expansions yet.
- **Team library is read-only locally** by design; edits happen at the source.

---

## Roadmap — Phase 2: click & action recording

Your original request also included recording clicks and dropdown selections and
replaying/editing them. That's a materially bigger feature that builds on the
same foundation this MVP establishes (global input hooks + injection). Planned
approach:

1. **Recorder** — capture a timeline of events (mouse position + clicks, key
   presses, and, where the OS accessibility API exposes it, the *target
   element/dropdown value* rather than raw coordinates, so playback survives
   window moves).
2. **Editable macro format** — store each recording as a JSON step list
   (`click`, `type`, `select`, `wait`) that opens in an editor — reorder,
   delete, tweak values, add pauses.
3. **Player** — replay steps via the existing injection layer, with
   coordinate + element-based targeting and configurable speed.
4. **Team sharing** — macros ride the same team-library sync you already have.

This phase needs careful per-OS accessibility work (macOS AX API, Windows UI
Automation) to make playback robust rather than brittle coordinate replay. Happy
to build it out next.

---

## License

MIT — see `LICENSE`.
