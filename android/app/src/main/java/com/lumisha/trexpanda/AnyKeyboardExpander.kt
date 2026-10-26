package com.lumisha.trexpanda

import java.text.BreakIterator

/**
 * Pure logic for "any-keyboard mode": given the full text of a field and the
 * caret position, decide whether the text just before the caret ends with a
 * trigger and, if so, what the field should contain afterwards and where the
 * caret goes. Kept free of Android framework types so it is unit-tested.
 */
object AnyKeyboardExpander {

    data class Edit(val text: String, val caret: Int, val trigger: String, val attachment: String? = null)

    fun expand(engine: ExpanderEngine, fullText: String, caret: Int): Edit? {
        if (caret < 0 || caret > fullText.length) return null
        val before = fullText.substring(0, caret)
        val action = engine.matchSuffix(before) ?: return null
        if (action.backspaces > before.length) return null
        val kept = before.substring(0, before.length - action.backspaces)
        val after = fullText.substring(caret)
        val newText = kept + action.replacement + after
        // Already correct (e.g. "github" -> "GitHub" typed as "GitHub"): don't
        // rewrite the field, which would reset the keyboard and could loop.
        if (newText == fullText) return null
        val back = charsForLastGraphemes(action.replacement, action.caretBack)
        return Edit(newText, kept.length + action.replacement.length - back, action.trigger, action.attachment)
    }

    /** The run of non-space characters just before the caret (what the user is typing). */
    fun currentToken(fullText: String, caret: Int): String {
        if (caret <= 0 || caret > fullText.length) return ""
        return Regex("(\\S+)$").find(fullText.substring(0, caret))?.value ?: ""
    }

    /**
     * Whether to show suggestions for this token. Triggers usually start with a
     * symbol (";addr", ",ch", "!rc"); plain words need 3+ letters so ordinary
     * typing doesn't pop suggestions on every word.
     */
    fun shouldSuggest(token: String): Boolean =
        token.isNotEmpty() && (!token[0].isLetterOrDigit() || token.length >= 3)

    /** Replace the token before the caret with the snippet for [trigger] (a tapped suggestion). */
    fun applySuggestion(engine: ExpanderEngine, fullText: String, caret: Int, trigger: String): Edit? {
        if (caret < 0 || caret > fullText.length) return null
        val action = engine.snippetAction(trigger) ?: return null
        val before = fullText.substring(0, caret)
        val token = currentToken(fullText, caret)
        val kept = before.substring(0, before.length - token.length)
        val after = fullText.substring(caret)
        val back = charsForLastGraphemes(action.replacement, action.caretBack)
        return Edit(kept + action.replacement + after, kept.length + action.replacement.length - back, action.trigger, action.attachment)
    }

    /** Number of UTF-16 chars making up the last [graphemes] user-visible characters of [s]. */
    internal fun charsForLastGraphemes(s: String, graphemes: Int): Int {
        if (graphemes <= 0 || s.isEmpty()) return 0
        val it = BreakIterator.getCharacterInstance()
        it.setText(s)
        var end = it.last()
        var count = 0
        while (count < graphemes) {
            val prev = it.previous()
            if (prev == BreakIterator.DONE) break
            end = prev
            count++
        }
        return s.length - end
    }
}
