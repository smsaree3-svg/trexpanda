package com.lumisha.trexpanda

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import java.io.IOException

/**
 * Thin PostgREST client for the `snippets` table — the Android equivalent of the
 * desktop app's cloud.pullSnippets / cloud.pushSnippets.
 *
 * Every request carries the anon key (`apikey`) and the signed-in user's bearer
 * token, so Row Level Security scopes all reads and writes to that user's rows.
 */
class SupabaseClient(private val auth: AuthManager) {

    private val http = OkHttpClient()

    /** Pull ALL of the caller's snippet rows (live + tombstones). */
    @Throws(IOException::class)
    fun pullSnippets(): List<Snippet> {
        val token = auth.freshAccessToken() ?: throw IOException("Not signed in.")
        val uid = auth.userId ?: throw IOException("Not signed in.")
        val url = SupabaseConfig.restUrl(
            "snippets?user_id=eq.$uid&select=id,trigger,replacement,label,html,attachment,enabled,updated_at,deleted_at"
        )
        val req = Request.Builder()
            .url(url)
            .addHeader("apikey", SupabaseConfig.anonKey)
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Accept", "application/json")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            val body = resp.body?.string() ?: "[]"
            if (!resp.isSuccessful) throw IOException("Pull failed (${resp.code}): $body")
            return SnippetJson.rowsFromArray(JSONArray(body))
        }
    }

    /** Upsert changed rows (keyed by id). A row with deleted_at set is a deletion. */
    @Throws(IOException::class)
    fun pushSnippets(rows: List<Snippet>): Int {
        if (rows.isEmpty()) return 0
        val token = auth.freshAccessToken() ?: throw IOException("Not signed in.")
        val uid = auth.userId ?: throw IOException("Not signed in.")

        val payload = JSONArray().apply {
            rows.forEach { put(SnippetJson.snippetToRow(it, uid)) }
        }
        val req = Request.Builder()
            .url(SupabaseConfig.restUrl("snippets?on_conflict=id"))
            .addHeader("apikey", SupabaseConfig.anonKey)
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Content-Type", "application/json")
            // merge-duplicates => upsert on the primary key; minimal => no row echo.
            .addHeader("Prefer", "resolution=merge-duplicates,return=minimal")
            .post(payload.toString().toRequestBody(JSON))
            .build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IOException("Push failed (${resp.code}): ${resp.body?.string()}")
            }
        }
        return rows.size
    }

    companion object {
        private val JSON = "application/json".toMediaType()
    }
}
