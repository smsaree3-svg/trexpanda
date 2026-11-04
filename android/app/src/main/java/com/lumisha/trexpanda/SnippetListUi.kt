package com.lumisha.trexpanda

import org.json.JSONObject

/**
 * Pure helpers for the snippet list screen: search, sort and editor validation.
 * No Android views here, so the rules are easy to read and unit-test.
 */
object SnippetListUi {

    enum class Sort(val key: String, val label: String) {
        AZ("az", "A–Z"),
        RECENT("recent", "Recent"),
        MOST_USED("used", "Most used");

        companion object {
            fun from(key: String?): Sort = Sort.entries.firstOrNull { it.key == key } ?: AZ
        }
    }

    /** True when [s] matches the search [query] (trigger, name, text or attachment name). */
    fun matches(s: Snippet, query: String): Boolean {
        val q = query.trim()
        if (q.isEmpty()) return true
        if (s.trigger?.contains(q, ignoreCase = true) == true) return true
        if (s.label?.contains(q, ignoreCase = true) == true) return true
        if (s.replacement.contains(q, ignoreCase = true)) return true
        val att = SnippetAttachment.parse(s.attachment)
        return att?.name?.contains(q, ignoreCase = true) == true
    }

    fun sort(list: List<Snippet>, sort: Sort, usage: JSONObject): List<Snippet> = when (sort) {
        // Same order the list always had (and the store screenshots rely on).
        Sort.AZ -> list.sortedBy { it.trigger ?: "" }
        Sort.RECENT -> list.sortedWith(compareByDescending<Snippet> { it.updatedAt }.thenBy { it.trigger ?: "" })
        Sort.MOST_USED -> list.sortedWith(
            compareByDescending<Snippet> { UsageStats.countFor(usage, it) }.thenBy { it.trigger ?: "" }
        )
    }

    /** A search query that could be used as-is as a new trigger (no spaces). */
    fun looksLikeTrigger(query: String): Boolean {
        val q = query.trim()
        return q.isNotEmpty() && q.length <= 40 && q.none { it.isWhitespace() }
    }

    /**
     * The error to show under the trigger field, or null when it's fine.
     * [original] is the trigger the snippet had before editing: leaving it as it
     * was is always allowed, so older snippets synced from the desktop never get
     * stuck.
     */
    fun triggerError(trigger: String, original: String?, others: List<Snippet>, requireNonEmpty: Boolean): String? {
        val t = trigger.trim()
        if (t.isEmpty()) return if (requireNonEmpty) "Enter a trigger, for example ;addr" else null
        if (original != null && t == original) return null
        if (t.any { it.isWhitespace() }) return "Triggers can't contain spaces."
        if (others.any { it.trigger?.trim().equals(t, ignoreCase = true) }) {
            return "You already have a snippet with this trigger."
        }
        return null
    }
}
