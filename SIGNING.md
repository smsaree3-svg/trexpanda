# Code Signing & Auto-Updates

This makes two things work:

- **No scary warnings** — a signed installer doesn't trip Windows SmartScreen's
  "unknown publisher" wall or macOS Gatekeeper.
- **One-click auto-updates** — installed apps check GitHub Releases on launch and
  update themselves (the app already calls `autoUpdater.checkForUpdatesAndNotify`
  in `src/main.js`, and `package.json` → `build.publish` points at this repo).

The build workflow (`.github/workflows/build.yml`) is **already wired** to sign
when the right secrets exist, and to publish update metadata (`latest.yml`) with
each tagged release. You just need to supply a certificate and add a few secrets.
Until you do, builds still succeed — they're just unsigned, and auto-update won't
install on Windows (signature can't be verified).

> The certificate itself is the one piece that has to come from you: it's a paid,
> identity-verified product, and its private key must stay in your control.

## Windows (Authenticode)

1. **Get a code-signing certificate** from a CA — DigiCert, Sectigo, or SSL.com.
   Ask specifically for one usable in **CI** (a software `.pfx`/`.p12` file).
   Note: current CA/Browser-Forum rules push most certs onto hardware tokens or a
   cloud HSM. SSL.com's **eSigner** (cloud signing) and similar services are the
   CI-friendly route; a plain hardware-token OV cert can't be used from GitHub
   Actions. (An EV cert clears SmartScreen instantly; OV builds reputation over
   time.)

2. **Export it** as a password-protected `.pfx`.

3. **Base64-encode it** so it can live in a secret. In PowerShell:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Set-Clipboard
   ```
   (or `base64 -w0 cert.pfx` on macOS/Linux).

4. **Add two repository secrets** — repo → Settings → Secrets and variables →
   Actions → **Secrets** tab → New repository secret:
   - `WIN_CSC_LINK` — the base64 string from step 3
   - `WIN_CSC_KEY_PASSWORD` — the `.pfx` password

That's it. The next tagged release builds a **signed** `.exe`.

## macOS (optional — only if you ship a Mac build)

1. **Apple Developer Program** membership ($99/yr).
2. Create a **Developer ID Application** certificate, export it as a `.p12`, and
   base64-encode it (as above).
3. Add secrets:
   - `MAC_CSC_LINK` — base64 of the `.p12`
   - `MAC_CSC_KEY_PASSWORD` — its password
   - `APPLE_ID` — your Apple ID email
   - `APPLE_APP_SPECIFIC_PASSWORD` — an app-specific password (appleid.apple.com)
   - `APPLE_TEAM_ID` — your 10-character Team ID
4. Enable notarization in `package.json` → `build.mac`:
   ```json
   "notarize": { "teamId": "YOURTEAMID" }
   ```
   (`hardenedRuntime` is already set, which notarization requires.)

## Cutting a signed, auto-updatable release

```powershell
git checkout main; git pull
git tag v0.2.0
git push origin v0.2.0
```

The tag triggers the workflow, which builds the signed installers and publishes
them — plus `latest.yml` / `latest-mac.yml` — to a GitHub Release. Apps already
installed from a **previous signed release** then detect and install the update
on their next launch.

## Secrets at a glance

| Secret | Platform | What it is |
| --- | --- | --- |
| `WIN_CSC_LINK` | Windows | base64 of your `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | Windows | `.pfx` password |
| `MAC_CSC_LINK` | macOS | base64 of your `.p12` |
| `MAC_CSC_KEY_PASSWORD` | macOS | `.p12` password |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | macOS | notarization |

(The `SUPABASE_URL` / `SUPABASE_ANON_KEY` **variables** — separate from these
secrets — are what bundle the cloud config into the build; see `CLOUD_SETUP.md`.)

## Notes & gotchas

- **The very first signed release** just establishes the baseline — auto-update
  only kicks in for the *next* release after users are on a signed build. Users
  on the current unsigned build must install the first signed one manually.
- **Auto-update only fires for tag-triggered releases** (`v*`), not for the
  manual "Run workflow" artifact builds.
- Keep the `.pfx`/`.p12` and passwords out of the repo — they belong only in
  GitHub **Secrets** (encrypted), never in `Variables` or committed files.
