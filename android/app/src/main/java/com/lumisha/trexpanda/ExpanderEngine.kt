package com.lumisha.trexpanda

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

    private var map: LinkedHashMap<String, Snippet> = LinkedHashMap()
    private var maxTrigger: Int = 1
    private var buffer: String = ""

    init {
        setSnippets(snippets)
    }

    fun setSnippets(snippets: List<Snippet>) {
        val next = LinkedHashMap<String, Snippet>()
        var max = 1
        for (s in snippets) {
            val t = s.trigger
            if (t.isNullOrEmpty() || !s.enabled || s.isDeleted) continue
            next[t] = s
            if (t.length > max) max = t.length
        }
        map = next
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
        var best: String? = null
        for (trigger in map.keys) {
            if (buffer.endsWith(trigger)) {
                if (best == null || trigger.length > best!!.length) best = trigger
            }
        }
        val match = best ?: return null

        val snippet = map[match]!!
        val rendered = render(snippet.replacement)
        buffer = "" // consumed
        return Action(
            trigger = match,
            replacement = rendered.text,
            backspaces = match.length,
            caretBack = rendered.caretBack,
            html = snippet.html?.let { renderHtml(it) },
        )
    }

    /** Keep the buffer in sync when the user presses Backspace. */
    fun onBackspace() {
        if (buffer.isNotEmpty()) buffer = buffer.dropLast(1)
    }

    /**
     * Live autocomplete: snippets whose trigger STARTS WITH the current token
     * (the run of non-space characters at the end of the buffer).
     */
    fun suggestions(limit: Int = 6): Pair<String, List<Suggestion>> {
        val m = Regex("(\\S+)$").find(buffer)
        val token = m?.groupValues?.get(1) ?: ""
        if (token.isEmpty()) return "" to emptyList()

        val items = ArrayList<Suggestion>()
        for ((trigger, snippet) in map) {
            if (trigger.length >= token.length && trigger.startsWith(token)) {
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
     * is counted in CODE POINTS (not UTF-16 units) so one astral emoji is a single
     * Left-arrow step, matching the desktop engine.
     */
    fun render(replacement: String): Rendered {
        var text = resolveTokens(replacement)

        var caretBack = 0
        val marker = text.indexOf("\$|")
        if (marker != -1) {
            val after = text.substring(marker + 2).split("\$|").joinToString("")
            caretBack = after.codePointCount(0, after.length)
            text = text.substring(0, marker) + after
        }
        return Rendered(text, caretBack)
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
