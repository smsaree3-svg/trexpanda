package com.lumisha.trexpanda

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
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
        // The server returns at most PAGE rows per request: page until a short page,
        // or rows past the first page would look "missing" and get overwritten.
        val all = ArrayList<Snippet>()
        var offset = 0
        while (true) {
            val url = SupabaseConfig.restUrl(
                "snippets?user_id=eq.$uid&select=id,trigger,replacement,label,html,attachment,enabled,updated_at,deleted_at" +
                    "&order=id&limit=$PAGE&offset=$offset"
            )
            val req = Request.Builder()
                .url(url)
                .addHeader("apikey", SupabaseConfig.anonKey)
                .addHeader("Authorization", "Bearer $token")
                .addHeader("Accept", "application/json")
                .get()
                .build()
            val page = http.newCall(req).execute().use { resp ->
                val body = resp.body?.string() ?: "[]"
                if (!resp.isSuccessful) throw IOException("Pull failed (${resp.code}): $body")
                SnippetJson.rowsFromArray(JSONArray(body))
            }
            all.addAll(page)
            if (page.size < PAGE) return all
            offset += PAGE
        }
    }

    /** Upsert changed rows (keyed by id). A row with deleted_at set is a deletion. */
    @Throws(IOException::class)
    fun pushSnippets(rows: List<Snippet>): Int {
        if (rows.isEmpty()) return 0
        val token = auth.freshAccessToken() ?: throw IOException("Not signed in.")
        val uid = auth.userId ?: throw IOException("Not signed in.")

        // Rows with images/files can be ~1.4 MB each: send small batches so a big
        // library never exceeds the server's request size limit.
        val limit = 2 * 1024 * 1024
        var batch = JSONArray()
        var size = 0
        fun flush() {
            if (batch.length() == 0) return
            val req = Request.Builder()
                .url(SupabaseConfig.restUrl("snippets?on_conflict=id"))
                .addHeader("apikey", SupabaseConfig.anonKey)
                .addHeader("Authorization", "Bearer $token")
                .addHeader("Content-Type", "application/json")
                // merge-duplicates => upsert on the primary key; minimal => no row echo.
                .addHeader("Prefer", "resolution=merge-duplicates,return=minimal")
                .post(batch.toString().toRequestBody(JSON))
                .build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    throw IOException("Push failed (${resp.code}): ${resp.body?.string()}")
                }
            }
            batch = JSONArray(); size = 0
        }
        for (r in rows) {
            val row = SnippetJson.snippetToRow(r, uid)
            val n = row.toString().length
            if (batch.length() > 0 && size + n > limit) flush()
            batch.put(row); size += n
        }
        flush()
        return rows.size
    }

    /** Upload this device's usage row (one row per device; others are summed by readers). */
    @Throws(IOException::class)
    fun pushUsage(deviceId: String, local: JSONObject) {
        val token = auth.freshAccessToken() ?: throw IOException("Not signed in.")
        val uid = auth.userId ?: throw IOException("Not signed in.")
        val row = JSONObject()
            .put("user_id", uid).put("device_id", deviceId).put("platform", "android")
            .put("by_key", local.optJSONObject("byKey") ?: JSONObject())
            .put("totals", local.optJSONObject("totals") ?: JSONObject())
            .put("updated_at", java.time.Instant.now().toString())
        val req = Request.Builder()
            .url(SupabaseConfig.restUrl("usage_stats?on_conflict=user_id,device_id"))
            .addHeader("apikey", SupabaseConfig.anonKey)
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Content-Type", "application/json")
            .addHeader("Prefer", "resolution=merge-duplicates,return=minimal")
            .post(row.toString().toRequestBody(JSON))
            .build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("Usage upload failed (${resp.code}): ${resp.body?.string()}")
        }
    }

    /** All of the caller's per-device usage rows. */
    @Throws(IOException::class)
    fun pullUsage(): List<JSONObject> {
        val token = auth.freshAccessToken() ?: throw IOException("Not signed in.")
        val uid = auth.userId ?: throw IOException("Not signed in.")
        val req = Request.Builder()
            .url(SupabaseConfig.restUrl("usage_stats?user_id=eq.$uid&select=device_id,platform,by_key,totals,updated_at"))
            .addHeader("apikey", SupabaseConfig.anonKey)
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Accept", "application/json")
            .get()
            .build()
        return http.newCall(req).execute().use { resp ->
            val body = resp.body?.string() ?: "[]"
            if (!resp.isSuccessful) throw IOException("Usage read failed (${resp.code}): $body")
            val arr = JSONArray(body)
            (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
        }
    }

    /**
     * Permanently delete the signed-in user's account and all their cloud data
     * (the delete_my_account RPC). Returns null on success, or a user-facing
     * message when the server refuses (for example, an active subscription).
     */
    @Throws(IOException::class)
    fun deleteAccount(): String? {
        val token = auth.freshAccessToken() ?: throw IOException("Not signed in.")
        val req = Request.Builder()
            .url(SupabaseConfig.restUrl("rpc/delete_my_account"))
            .addHeader("apikey", SupabaseConfig.anonKey)
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Content-Type", "application/json")
            .post("{}".toRequestBody(JSON))
            .build()
        http.newCall(req).execute().use { resp ->
            val body = resp.body?.string() ?: ""
            if (!resp.isSuccessful) throw IOException("Delete failed (${resp.code}).")
            val json = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
            return if (json.optBoolean("ok", false)) null
            else json.optString("message", "Your account could not be deleted. Please contact hello@trexpanda.com.")
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private const val PAGE = 1000
    }
}
