package com.lumisha.trexpanda

import java.text.BreakIterator
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * Pure, dependency-free text-expansion engine — the faithful Kotlin port of the
 * desktop app's `src/expander.js`.
 *
 * You feed it characters one at a time (as the user types on the Trexpanda
 * keyboard) and it tells you when a trigger has matched and what to do: how many
 * characters of the trigger to delete, what to insert, and how far to move the
 * caret back afterwards. It knows nothing about Android, the IME, or Supabase,
 * so the whole expansion behaviour stays unit-testable in plain Kotlin.
 */
class ExpanderEngine(
    snippets: List<Snippet> = emptyList(),
    private val dynamicResolver: ((String) -> String?)? = null,
) {

    /** The result of a trigger match. */
    data class Action(
        val trigger: String,
        val replacement: String,
        val backspaces: Int,
        val caretBack: Int,
        val html: String? = null,
    )

    /** A live-autocomplete candidate. */
    data class Suggestion(
        val trigger: String,
        val preview: String,
        val hasAttachment: Boolean,
        val isHtml: Boolean,
    )

    /** One active trigger: the canonical (as-typed) spelling and its snippet. */
    private data class Entry(val trigger: String, val snippet: Snippet)

    // Case-insensitive active index: lowercased trigger -> Entry. Triggers match
    // case-insensitively, so ";ch", ";CH" and ";Ch" are the SAME trigger; exactly
    // one active snippet exists per lowercased trigger and the LAST definition
    // wins (SPEC-EXPANSION.md section 5). Lowercasing the key once here keeps the
    // per-keystroke match path free of per-trigger lowercase() calls.
    private var byLower: LinkedHashMap<String, Entry> = LinkedHashMap()
    private var maxTrigger: Int = 1
    private var buffer: String = ""

    init {
        setSnippets(snippets)
    }

    fun setSnippets(snippets: List<Snippet>) {
        val next = LinkedHashMap<String, Entry>()
        var max = 1
        for (s in snippets) {
            val t = s.trigger
            if (t.isNullOrEmpty() || !s.enabled || s.isDeleted) continue
            next[t.lowercase()] = Entry(t, s) // last definition wins per lowercased trigger
            if (t.length > max) max = t.length
        }
        byLower = next
        maxTrigger = max
        if (buffer.length > maxTrigger) buffer = buffer.takeLast(maxTrigger)
    }

    /** Clear the rolling buffer (call on focus change, Enter, cursor move, etc.). */
    fun reset() {
        buffer = ""
    }

    /** Feed a single printable character. Returns an [Action] when a trigger fires. */
    fun onChar(ch: Char): Action? {
        buffer = (buffer + ch).takeLast(maxTrigger)

        // Prefer the longest matching trigger so ";addr2" wins over ";addr".
        // Matching is case-insensitive against the precomputed lowercased keys.
        val lowerBuf = buffer.lowercase()
        val best = bestMatch(lowerBuf) ?: return null

        val snippet = best.snippet
        val rendered = render(snippet.replacement)
        buffer = "" // consumed
        return Action(
            trigger = best.trigger,
            replacement = rendered.text,
            backspaces = best.trigger.length,
            caretBack = rendered.caretBack,
            html = snippet.html?.let { renderHtml(it) },
        )
    }

    /** Longest active trigger whose lowercased form is a suffix of [lowerText]. */
    private fun bestMatch(lowerText: String): Entry? {
        var best: Entry? = null
        var bestLen = -1
        for ((lower, entry) in byLower) {
            if (lowerText.endsWith(lower) && lower.length > bestLen) {
                best = entry; bestLen = lower.length
            }
        }
        return best
    }

    /** Keep the buffer in sync when the user presses Backspace. */
    fun onBackspace() {
        if (buffer.isNotEmpty()) buffer = buffer.dropLast(1)
    }

    /**
     * Build the expansion for a known trigger, used when the user taps a live
     * suggestion. `backspaces` is the full trigger length; the caller may instead
     * delete only the partial token it already committed.
     */
    fun snippetAction(trigger: String): Action? {
        // Resolve case-insensitively: a tapped suggestion carries the canonical
        // trigger, but accept any-case input too.
        val entry = byLower[trigger.lowercase()] ?: return null
        val snippet = entry.snippet
        val rendered = render(snippet.replacement)
        buffer = ""
        return Action(
            trigger = entry.trigger,
            replacement = rendered.text,
            backspaces = trigger.length,
            caretBack = rendered.caretBack,
            html = snippet.html?.let { renderHtml(it) },
        )
    }

    /**
     * Live autocomplete: snippets whose trigger STARTS WITH the current token
     * (the run of non-space characters at the end of the buffer).
     */
    fun suggestions(limit: Int = 6): Pair<String, List<Suggestion>> {
        val m = Regex("(\\S+)$").find(buffer)
        val token = m?.groupValues?.get(1) ?: ""
        if (token.isEmpty()) return "" to emptyList()

        val tokenLower = token.lowercase()
        val items = ArrayList<Suggestion>()
        for ((lower, entry) in byLower) {
            val trigger = entry.trigger; val snippet = entry.snippet
            if (trigger.length >= token.length && lower.startsWith(tokenLower)) {
                val raw = snippet.replacement
                items.add(
                    Suggestion(
                        trigger = trigger,
                        preview = raw.replace(Regex("\\s+"), " ").trim().take(140),
                        hasAttachment = snippet.attachment != null,
                        isHtml = snippet.html != null,
                    )
                )
            }
        }
        items.sortWith(compareBy({ it.trigger.length }, { it.trigger }))
        return token to items.take(maxOf(1, limit))
    }

    /** Longest trigger length, so the IME knows how much preceding text to read. */
    fun maxTriggerLen(): Int = maxTrigger

    /**
     * Stateless match against the actual text before the caret. The IME calls
     * this with `getTextBeforeCursor(...)` after each committed character, so
     * expansion no longer depends on an internal buffer that cursor callbacks
     * could reset. Longest matching trigger wins.
     */
    fun matchSuffix(textBeforeCursor: CharSequence): Action? {
        val text = textBeforeCursor.toString().lowercase()
        val best = bestMatch(text) ?: return null
        val snippet = best.snippet
        val rendered = render(snippet.replacement)
        return Action(
            trigger = best.trigger,
            replacement = rendered.text,
            backspaces = best.trigger.length,
            caretBack = rendered.caretBack,
            html = snippet.html?.let { renderHtml(it) },
        )
    }

    /** Stateless suggestions from the last non-space token of the given text. */
    fun suggestionsFrom(textBeforeCursor: CharSequence, limit: Int = 6): Pair<String, List<Suggestion>> {
        val token = Regex("(\\S+)$").find(textBeforeCursor.toString())?.groupValues?.get(1) ?: ""
        if (token.isEmpty()) return "" to emptyList()
        val tokenLower = token.lowercase()
        val items = ArrayList<Suggestion>()
        for ((lower, entry) in byLower) {
            val trigger = entry.trigger; val snippet = entry.snippet
            if (trigger.length >= token.length && lower.startsWith(tokenLower)) {
                val raw = snippet.replacement
                items.add(
                    Suggestion(
                        trigger = trigger,
                        preview = raw.replace(Regex("\\s+"), " ").trim().take(140),
                        hasAttachment = snippet.attachment != null,
                        isHtml = snippet.html != null,
                    )
                )
            }
        }
        items.sortWith(compareBy({ it.trigger.length }, { it.trigger }))
        return token to items.take(maxOf(1, limit))
    }

    /** Result of [render]: the final text and how far to move the caret back. */
    data class Rendered(val text: String, val caretBack: Int)

    /**
     * Expand dynamic tokens ({date} {time} {datetime} plus any custom resolver)
     * and locate the "$|" caret marker. The marker is removed; [Rendered.caretBack]
     * is counted in GRAPHEME CLUSTERS (user-perceived characters) via the platform
     * Unicode segmenter, the same unit DPAD_LEFT moves the caret by, so a flag,
     * skin-tone, or ZWJ emoji is one step. This matches the desktop and iOS engines.
     */
    fun render(replacement: String): Rendered {
        var text = resolveTokens(replacement)

        var caretBack = 0
        val marker = text.indexOf("\$|")
        if (marker != -1) {
            val after = text.substring(marker + 2).split("\$|").joinToString("")
            caretBack = graphemeCount(after)
            text = text.substring(0, marker) + after
        }
        return Rendered(text, caretBack)
    }

    /** Grapheme-cluster count via BreakIterator (ICU-backed on Android). */
    private fun graphemeCount(s: String): Int {
        if (s.isEmpty()) return 0
        val it = BreakIterator.getCharacterInstance()
        it.setText(s)
        var count = 0
        it.first()
        while (it.next() != BreakIterator.DONE) count++
        return count
    }

    /** Resolve {tokens} in an HTML replacement and strip every "$|" marker. */
    fun renderHtml(html: String): String =
        resolveTokens(html).split("\$|").joinToString("")

    private fun resolveTokens(input: String): String =
        Regex("\\{(\\w+)\\}").replace(input) { mr ->
            val name = mr.groupValues[1]
            dynamicResolver?.invoke(name) ?: builtinToken(name) ?: mr.value
        }

    private fun builtinToken(name: String): String? = when (name) {
        "date" -> LocalDate.now().format(DATE)
        "time" -> LocalTime.now().format(TIME)
        "datetime" -> LocalDate.now().format(DATE) + " " + LocalTime.now().format(TIME)
        else -> null
    }

    companion object {
        private val DATE: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")
        private val TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
    }
}
