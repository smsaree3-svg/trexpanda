package com.lumisha.trexpanda

/**
 * One personal snippet, the Android mirror of the desktop app's snippet shape
 * and of a row in the Supabase `snippets` table.
 *
 * Timestamps are epoch milliseconds here. The Supabase row stores them as
 * timestamptz (ISO-8601); [SupabaseClient] converts at the boundary so the
 * engine and the sync merge only ever deal in millis.
 *
 * `deletedAt != null` marks a soft-delete tombstone (a deletion that must
 * propagate to the other devices instead of the row silently reappearing on
 * the next pull).
 */
data class Snippet(
    val id: String,
    val trigger: String?,
    val replacement: String = "",
    val label: String? = null,
    val html: String? = null,
    /** Raw JSON of any attachment column; carried through untouched for now. */
    val attachment: String? = null,
    val enabled: Boolean = true,
    val updatedAt: Long = 0L,
    val deletedAt: Long? = null,
) {
    val isDeleted: Boolean get() = deletedAt != null

    /** A content signature used to decide whether an edit actually changed anything. */
    fun signature(): String = buildString {
        append(trigger ?: "").append('\u0001')
        append(replacement).append('\u0001')
        append(label ?: "").append('\u0001')
        append(enabled).append('\u0001')
        append(html ?: "").append('\u0001')
        append(attachment ?: "")
    }
}

/** A local record that a snippet id was deleted, kept until it ages out (TTL). */
data class Tombstone(
    val id: String,
    val trigger: String?,
    val deletedAt: Long,
)
