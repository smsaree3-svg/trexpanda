# Trexpanda for Android

The Android companion to the Trexpanda desktop app: a custom keyboard (IME) that
expands your snippets as you type, backed by the **same Supabase `snippets`
table** as the desktop. A snippet created on the PC shows up on the phone, and
vice versa, through the cross-device sync built into both apps.

## How it works

Android does not allow a global keyboard hook the way the desktop does, so
expansion happens inside our own keyboard. When you type on the Trexpanda
keyboard and a trigger completes, the keyboard deletes the trigger and inserts
the replacement through the standard input connection. This is the Play-safe
approach (no accessibility service required).

- **Offline-first.** Snippets live in a local JSON store, so the keyboard works
  with no network. The companion app syncs that store with Supabase.
- **Shared engine.** The expansion engine (`ExpanderEngine`), the cross-device
  merge (`SyncMerge`, last-write-wins + tombstones), and the local reconcile
  (`SnippetReconcile`) are faithful Kotlin ports of the desktop's
  `expander.js` / `store.js`, with the same behaviour and unit tests.

## Project layout

```
android/
  app/src/main/java/com/lumisha/trexpanda/
    Snippet.kt               data model (mirrors the snippets table)
    ExpanderEngine.kt        text-expansion engine (port of expander.js)
    SyncMerge.kt             cross-device merge (port of mergeSnippetsForSync)
    SnippetReconcile.kt      local save reconcile (port of Store.setPersonal)
    SnippetStore.kt          offline JSON persistence
    SupabaseConfig.kt        URL / anon key (from BuildConfig)
    AuthManager.kt           Google sign-in via Supabase GoTrue (PKCE)
    SupabaseClient.kt        PostgREST pull/push for the snippets table
    SyncManager.kt           pull -> merge -> apply -> push
    TrexpandaKeyboardView.kt the on-screen keyboard
    TrexpandaImeService.kt   the IME (expands as you type)
    MainActivity.kt          sign-in, snippet management, sync, setup
    SnippetAdapter.kt        snippet list
  app/src/test/java/...      JUnit tests for the three pure engines
```

## Setup

1. **Supabase.** Use the same project as the desktop app. In the Supabase
   dashboard:
   - Authentication -> Providers: enable **Google**.
   - Authentication -> URL Configuration -> Redirect URLs: add
     `trexpanda://auth`.
2. **Keys.** Copy `local.properties.example` to `local.properties` and set:
   ```
   SUPABASE_URL=https://yiltfbpjubflwdajzrhe.supabase.co
   SUPABASE_ANON_KEY=<your anon public key>
   ```
   These are injected into `BuildConfig` at build time; nothing is hard-coded.
   (The anon key is public and safe to ship; RLS protects the data.)

## Build and run

Open the `android/` folder in Android Studio (Giraffe or newer, JDK 17) and Run,
or from the command line once the Gradle wrapper is present:

```
./gradlew assembleDebug      # build the APK
./gradlew test               # run the unit tests (engine, merge, reconcile)
```

On the device: open Trexpanda, **Sign in with Google**, then **Enable keyboard**
(Android Settings) and **Switch keyboard** to Trexpanda. Add snippets in the app
or let them sync down from the desktop.

## Current scope and next steps

- Expansion inserts **plain text**. HTML snippets fall back to their plain
  replacement, and attachments are not inserted from the keyboard (platform
  input connections are plain-text); both round-trip through sync untouched.
- Auth tokens are stored in `SharedPreferences`. For production, move them to
  `EncryptedSharedPreferences` (androidx.security-crypto).
- Natural follow-ups: an inline suggestion strip (the engine already exposes
  `suggestions()`), periodic background sync, and email/password sign-in.

Built for Lumisha LLC. Type Less. Do More.
