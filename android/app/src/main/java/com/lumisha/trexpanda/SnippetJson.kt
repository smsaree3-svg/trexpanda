package com.lumisha.trexpanda

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.OffsetDateTime

/**
 * JSON (de)serialization for snippets and tombstones, shared by local storage
 * ([SnippetStore]) and the Supabase REST layer ([SupabaseClient]).
 *
 * Supabase stores timestamps as ISO-8601 timestamptz; everything in-app uses
 * epoch millis, so the conversion lives here at the boundary.
 */
object SnippetJson {

    // ---- timestamps ----------------------------------------------------------

    fun isoToMillis(iso: String?): Long {
        if (iso.isNullOrBlank()) return 0L
        return try {
            OffsetDateTime.parse(iso).toInstant().toEpochMilli()
        } catch (_: Exception) {
            try { Instant.parse(iso).toEpochMilli() } catch (_: Exception) { 0L }
        }
    }

    fun millisToIso(ms: Long): String = Instant.ofEpochMilli(ms).toString()

    // ---- local (camelCase) storage shape ------------------------------------

    fun snippetToLocalJson(s: Snippet): JSONObject = JSONObject().apply {
        put("id", s.id)
        put("trigger", s.trigger ?: JSONObject.NULL)
        put("replacement", s.replacement)
        put("label", s.label ?: JSONObject.NULL)
        put("html", s.html ?: JSONObject.NULL)
        put("attachment", s.attachment ?: JSONObject.NULL)
        put("enabled", s.enabled)
        put("updatedAt", s.updatedAt)
        put("deletedAt", s.deletedAt ?: JSONObject.NULL)
        if (s.attachmentCleared) put("attachmentCleared", true)
    }

    fun snippetFromLocalJson(o: JSONObject): Snippet = Snippet(
        id = o.optString("id", ""),
        trigger = o.optStringOrNull("trigger"),
        replacement = o.optString("replacement", ""),
        label = o.optStringOrNull("label"),
        html = o.optStringOrNull("html"),
        attachment = o.optStringOrNull("attachment"),
        enabled = o.optBoolean("enabled", true),
        updatedAt = o.optLong("updatedAt", 0L),
        deletedAt = if (o.isNull("deletedAt")) null else o.optLong("deletedAt"),
        attachmentCleared = o.optBoolean("attachmentCleared", false),
    )

    fun tombstoneToJson(t: Tombstone): JSONObject = JSONObject().apply {
        put("id", t.id)
        put("trigger", t.trigger ?: JSONObject.NULL)
        put("deletedAt", t.deletedAt)
    }

    fun tombstoneFromJson(o: JSONObject): Tombstone = Tombstone(
        id = o.optString("id", ""),
        trigger = o.optStringOrNull("trigger"),
        deletedAt = o.optLong("deletedAt", 0L),
    )

    fun snippetsToLocalArray(list: List<Snippet>): JSONArray =
        JSONArray().apply { list.forEach { put(snippetToLocalJson(it)) } }

    fun tombstonesToArray(list: List<Tombstone>): JSONArray =
        JSONArray().apply { list.forEach { put(tombstoneToJson(it)) } }

    fun snippetsFromLocalArray(arr: JSONArray): List<Snippet> =
        (0 until arr.length()).map { snippetFromLocalJson(arr.getJSONObject(it)) }

    fun tombstonesFromArray(arr: JSONArray): List<Tombstone> =
        (0 until arr.length()).map { tombstoneFromJson(arr.getJSONObject(it)) }

    // ---- Supabase (snake_case) REST shape ------------------------------------

    /** Build a PostgREST row for upsert. `userId` is stamped by the caller. */
    fun snippetToRow(s: Snippet, userId: String): JSONObject = JSONObject().apply {
        put("id", s.id)
        put("user_id", userId)
        put("trigger", s.trigger ?: JSONObject.NULL)
        put("replacement", s.replacement)
        put("label", s.label ?: JSONObject.NULL)
        put("html", s.html ?: JSONObject.NULL)
        // Removed on purpose: send the marker so other devices drop their copy too.
        put("attachment", s.attachment?.let { safeJson(it) }
            ?: if (s.attachmentCleared) JSONObject(ATTACHMENT_CLEARED) else JSONObject.NULL)
        put("enabled", s.enabled)
        put("updated_at", millisToIso(if (s.updatedAt > 0) s.updatedAt else System.currentTimeMillis()))
        put("deleted_at", s.deletedAt?.let { millisToIso(it) } ?: JSONObject.NULL)
    }

    fun snippetFromRow(o: JSONObject): Snippet {
        val raw = if (o.isNull("attachment")) null else o.get("attachment").toString()
        val cleared = raw != null && isClearedMarker(raw)
        return Snippet(
            id = o.optString("id", ""),
            trigger = o.optStringOrNull("trigger"),
            replacement = o.optString("replacement", ""),
            label = o.optStringOrNull("label"),
            html = o.optStringOrNull("html"),
            attachment = if (cleared) null else raw,
            enabled = o.optBoolean("enabled", true),
            updatedAt = isoToMillis(o.optStringOrNull("updated_at")),
            deletedAt = o.optStringOrNull("deleted_at")?.let { isoToMillis(it) },
            attachmentCleared = cleared,
        )
    }

    /** Same marker the desktop and iPhone apps sync when an attachment is removed on purpose. */
    const val ATTACHMENT_CLEARED = """{"type":"none","cleared":true}"""

    fun isClearedMarker(raw: String): Boolean = try {
        val j = JSONObject(raw)
        j.optBoolean("cleared", false) && !j.has("data")
    } catch (_: Exception) { false }

    fun rowsFromArray(arr: JSONArray): List<Snippet> =
        (0 until arr.length()).map { snippetFromRow(arr.getJSONObject(it)) }

    /** attachment is a jsonb column; pass through an object if it parses, else a string. */
    private fun safeJson(raw: String): Any = try {
        JSONObject(raw)
    } catch (_: Exception) {
        try { JSONArray(raw) } catch (_: Exception) { raw }
    }
}

private fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key) || !has(key)) null else optString(key, "").ifEmpty { null }
