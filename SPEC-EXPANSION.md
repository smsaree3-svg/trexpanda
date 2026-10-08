# Trexpanda Expansion Specification (v1)

The single behavioral contract for text expansion. The engine is implemented
natively three times (desktop `src/expander.js`, Android
`ExpanderEngine.kt`, iOS `ExpanderEngine.swift`). The implementations stay
native; this document defines the behavior they must all produce identically,
so a snippet behaves the same on Windows, macOS, Android, and iPhone.

Every rule here is covered by automated tests (`test/expander.test.js`,
`ExpanderEngineTest.kt`, and the iOS `ExpanderEngineTests.swift`).

## 1. A snippet

A snippet has a `trigger` (the shortcut the user types) and a `replacement`
(the text it expands to). It may be `enabled` or disabled, and may be marked
deleted. Only enabled, non-deleted snippets with a non-empty trigger are active.

## 2. Matching

- A trigger fires when the text immediately before the cursor ends with it.
- Matching is **case-insensitive**: `;ch`, `;CH`, and `;Ch` all fire a snippet
  whose stored trigger is any casing of `;ch`.
- When several triggers match at once, the **longest** one wins. Example: with
  `;a` and `x;a` defined, typing `x;a` fires `x;a`.
- The number of characters to delete before inserting (`backspaces`) equals the
  length of the stored trigger.
- The `trigger` reported on a match is the **stored (canonical) spelling**, not
  what the user happened to type. Case typed by the user never changes output.

## 3. Dynamic tokens

Inside a replacement, these tokens are resolved fresh at expansion time:

| Token        | Expands to                        | Format       |
|--------------|-----------------------------------|--------------|
| `{date}`     | current date                      | `yyyy-MM-dd` |
| `{time}`     | current time, 24-hour             | `HH:mm`      |
| `{datetime}` | date and time                     | `yyyy-MM-dd HH:mm` |

- Every occurrence of a known token is replaced.
- An **unknown** token such as `{name}` is left untouched, exactly as written.
  (This keeps the door open for user variables later without breaking today's
  snippets.)
- Token names are matched as `{word}` (letters, digits, underscore).
- **Time zone: all tokens resolve in the user's LOCAL time zone.** `{date}` is
  the user's local calendar date, so it never disagrees with the phone near
  midnight. (Clarified in this revision after the audit: the desktop engine was
  using UTC for `{date}`; it now matches Android and iOS, which were already
  local. If UTC is ever wanted instead, it must change on all three at once.)

## 4. Cursor marker `$|`

- `$|` marks where the cursor should land after the text is inserted.
- The **first** `$|` sets the cursor. Its position is reported as `caretBack`.
- All `$|` markers are removed from the inserted text (the first and any extras).
- Example: `Dear $|,\nRegards` inserts `Dear ,\nRegards` and places the cursor
  right after `Dear `, so `caretBack` is the length of `,\nRegards`.

### caretBack is counted in grapheme clusters (resolved)
`caretBack` is the number of **grapheme clusters** (user-perceived characters)
between the cursor and the end of the inserted text. This is the correct and only
sensible unit, because every platform moves the cursor one step per grapheme: the
desktop sends Left-arrow key presses, Android sends `DPAD_LEFT`, and iOS calls
`adjustTextPosition(byCharacterOffset: -1)` in a loop, and on all of them one step
moves past one user-perceived character. A flag (`🇺🇸`), a skin-tone emoji
(`👍🏽`), or a ZWJ sequence (`👨‍👩‍👧`) is therefore a single step, even though it
spans several code points.

Each engine counts with its platform's native Unicode segmenter, the same one the
OS uses to move the cursor: `Intl.Segmenter` on desktop, `BreakIterator`
(ICU-backed) on Android, and Swift's grapheme clusters on iOS. These agree, so the
cursor lands at the same visual position on every platform. (This replaces an
earlier desktop/Android implementation that counted code points, which over-shot
the cursor for flags, skin-tone, and ZWJ emoji.)

The only inherent, bounded limitation: grapheme segmentation tracks the Unicode
version built into each OS. For an emoji so new that one OS renders it as a single
glyph while an older OS does not yet know it, each device still lands the cursor
correctly for how it renders the text, because the engine counts with the same
segmenter the OS moves the cursor by, but the raw integer could differ by one step
between those two OS versions. This is a property of native text systems, not of
Trexpanda, and cannot be removed without shipping our own Unicode tables.

## 5. Edge cases (defined behavior)

- **Empty replacement**: a snippet with an empty replacement expands to nothing.
  The trigger is still deleted (`backspaces` = trigger length), so typing it
  simply removes it. This is a valid "delete this shortcut" behavior.
- **Empty trigger**: ignored. Never active.
- **Disabled or deleted snippet**: never matches, never suggested.
- **Duplicate triggers**: if two active snippets share a trigger (case-insensitive),
  the **last one defined wins**. There is exactly one active snippet per trigger.
- **Multiline replacement**: inserted verbatim, including newlines.
- **Unicode and emoji**: inserted verbatim.

## 6. Live suggestions

- As the user types, the current **token** is the run of non-whitespace
  characters at the end of the text before the cursor.
- A snippet is suggested when its trigger **starts with** the current token
  (case-insensitive) and is at least as long as the token.
- Suggestions are ordered **shortest trigger first**, then alphabetically, so the
  closest match is first.
- The preview is the replacement with runs of whitespace collapsed to single
  spaces, trimmed, and capped at 140 characters.
- A result set is capped (default 6).

## 7. Statelessness (reliability)

Matching is stateless: the keyboard feeds the engine the actual text before the
cursor after each keystroke, rather than trusting an internal buffer that the OS
or another app could reset. This is why expansion is reliable across every app
and field. The engine performs **no network calls** on the expansion path; it
reads only the local, in-memory snippet set.

## 8. Ordering of suggestions

Secondary ordering (after shortest-trigger-first) is **plain lexicographic by
code unit**, not locale-aware. All three platforms order identically, so the
same account shows the same suggestion order everywhere. (Clarified after the
audit: the desktop engine was using a locale-aware comparison and now uses plain
lexicographic, matching Android and iOS.)

---

## Conformance suite: ExpansionSpecificationV1

This specification is enforced by a canonical, contractual test suite of the
same name on every platform. These are not incidental implementation tests;
they are the behavior contract, and must not be weakened to make a change pass.

- Desktop: `test/expansion-spec-v1.test.js` (in `npm test` and `npm run test:spec`)
- Android: `ExpansionSpecificationV1Test.kt`
- iOS: `ExpansionSpecificationV1Tests.swift`

## Appendix: Performance baseline (v1)

Measured on the desktop (Node) engine, which uses the identical algorithm to the
Android and iOS engines (linear scan over the active trigger set, with the
lowercased key precomputed at load). Methodology: `bench/stress.js`, warm then
timed, per-keystroke match cost measured with a non-matching keystroke that
forces a full scan; suggestion cost measured mid-token.

| Snippets | Match / keystroke | Suggestions |
|---------:|------------------:|------------:|
| 10       | 0.20 µs           | 6 µs        |
| 100      | 1.0 µs            | 50 µs       |
| 1,000    | 11 µs             | 0.55 ms     |
| 5,000    | 55 µs             | 2.9 ms      |
| 10,000   | 80 µs             | 4.1 ms      |

Conclusion: the expansion path is effectively instantaneous even at 10,000
snippets (0.08 ms/keystroke) and does no network work, satisfying the
performance contract. Live suggestions are the only cost that grows with library
size; the documented future optimization (rank matches, then build previews only
for the top results) makes it flat, and is not needed at realistic sizes.
