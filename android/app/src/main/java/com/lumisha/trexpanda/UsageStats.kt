package com.lumisha.trexpanda

import android.content.Context
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/**
 * Snippet use counts and characters saved, in the same shape as the desktop app
 * (`usage_stats` row: by_key {key: {count, lastUsedAt}}, totals {expansions,
 * savedChars, typedChars, since}). This device keeps its own numbers locally and
 * uploads them as its own row; the combined view (all devices) is cached after
 * each sync for display.
 */
object UsageStats {
    private const val PREFS = "trex_usage"
    private const val KEY_LOCAL = "local"
    private const val KEY_COMBINED = "combined"
    private const val KEY_DEVICE = "device_id"
    private val lock = Any()

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun deviceId(c: Context): String = synchronized(lock) {
        val p = prefs(c)
        p.getString(KEY_DEVICE, null) ?: UUID.randomUUID().toString().also { p.edit().putString(KEY_DEVICE, it).apply() }
    }

    fun local(c: Context): JSONObject = synchronized(lock) { normalize(prefs(c).getString(KEY_LOCAL, null)) }

    /** All devices combined (last sync), falling back to this device's numbers. */
    fun combined(c: Context): JSONObject = synchronized(lock) {
        val raw = prefs(c).getString(KEY_COMBINED, null)
        if (raw != null) normalize(raw) else local(c)
    }

    /** Record one expansion of the snippet [key] (snippet id, or "t:<trigger>"). */
    fun record(c: Context, key: String, typedChars: Int, outChars: Int) = synchronized(lock) {
        val u = local(c)
        val now = Instant.now().toString()
        val byKey = u.getJSONObject("byKey")
        if (key.isNotEmpty()) {
            val prev = byKey.optJSONObject(key)
            byKey.put(key, JSONObject().put("count", (prev?.optInt("count") ?: 0) + 1).put("lastUsedAt", now))
        }
        val t = u.getJSONObject("totals")
        val typed = typedChars.coerceAtLeast(0)
        t.put("expansions", t.optLong("expansions") + 1)
        t.put("typedChars", t.optLong("typedChars") + typed)
        t.put("savedChars", t.optLong("savedChars") + (outChars - typed).coerceAtLeast(0))
        if (t.optString("since").isEmpty()) t.put("since", now)
        prefs(c).edit().putString(KEY_LOCAL, u.toString()).apply()
        // Keep the combined view moving between syncs too.
        val comb = prefs(c).getString(KEY_COMBINED, null)
        if (comb != null) {
            val cu = normalize(comb)
            val cb = cu.getJSONObject("byKey")
            if (key.isNotEmpty()) {
                val prev = cb.optJSONObject(key)
                cb.put(key, JSONObject().put("count", (prev?.optInt("count") ?: 0) + 1).put("lastUsedAt", now))
            }
            val ct = cu.getJSONObject("totals")
            ct.put("expansions", ct.optLong("expansions") + 1)
            ct.put("savedChars", ct.optLong("savedChars") + (outChars - typed).coerceAtLeast(0))
            prefs(c).edit().putString(KEY_COMBINED, cu.toString()).apply()
        }
    }

    /** Record an expansion of [trigger], keyed by the matching personal snippet's id. */
    fun recordTrigger(c: Context, trigger: String, typedChars: Int, outChars: Int) {
        val id = try {
            SnippetStore.peekPersonal(c).firstOrNull { it.trigger.equals(trigger, ignoreCase = true) }?.id
        } catch (_: Exception) { null }
        record(c, if (!id.isNullOrEmpty()) id else "t:$trigger", typedChars, outChars)
    }

    fun saveCombined(c: Context, combined: JSONObject) = synchronized(lock) {
        prefs(c).edit().putString(KEY_COMBINED, combined.toString()).apply()
    }

    fun reset(c: Context) = synchronized(lock) {
        prefs(c).edit().remove(KEY_LOCAL).remove(KEY_COMBINED).apply()
    }

    /** Combine this device's numbers with the other devices' rows (pure). */
    fun combine(local: JSONObject, rows: List<JSONObject>, deviceId: String): JSONObject {
        val byKey = JSONObject()
        var expansions = 0L; var saved = 0L; var typed = 0L; var since: String? = null; var devices = 0
        fun add(bk: JSONObject?, t: JSONObject?) {
            devices++
            bk?.keys()?.forEach { k ->
                val v = bk.optJSONObject(k) ?: return@forEach
                val cur = byKey.optJSONObject(k) ?: JSONObject().put("count", 0)
                cur.put("count", cur.optInt("count") + v.optInt("count").coerceAtLeast(0))
                val lu = v.optString("lastUsedAt")
                if (lu.isNotEmpty() && (cur.optString("lastUsedAt").isEmpty() || lu > cur.optString("lastUsedAt"))) cur.put("lastUsedAt", lu)
                byKey.put(k, cur)
            }
            if (t != null) {
                expansions += t.optLong("expansions").coerceAtLeast(0)
                saved += t.optLong("savedChars").coerceAtLeast(0)
                typed += t.optLong("typedChars").coerceAtLeast(0)
                val s = t.optString("since")
                if (s.isNotEmpty() && (since == null || s < since!!)) since = s
            }
        }
        add(local.optJSONObject("byKey"), local.optJSONObject("totals"))
        rows.forEach { r -> if (r.optString("device_id") != deviceId) add(r.optJSONObject("by_key"), r.optJSONObject("totals")) }
        val totals = JSONObject().put("expansions", expansions).put("savedChars", saved).put("typedChars", typed).put("devices", devices)
        since?.let { totals.put("since", it) }
        return JSONObject().put("byKey", byKey).put("totals", totals)
    }

    /** Minutes saved at [wpm] words per minute (5 characters = 1 word). */
    fun minutesSaved(u: JSONObject, wpm: Int = 35): Double =
        u.optJSONObject("totals")?.optLong("savedChars")?.let { it / 5.0 / wpm.coerceAtLeast(5) } ?: 0.0

    fun countFor(u: JSONObject, snippet: Snippet): Int {
        val bk = u.optJSONObject("byKey") ?: return 0
        return (bk.optJSONObject(snippet.id)?.optInt("count") ?: 0).takeIf { it > 0 }
            ?: (bk.optJSONObject("t:${snippet.trigger}")?.optInt("count") ?: 0)
    }

    fun formatDuration(min: Double): String = when {
        min <= 0 -> "0 min"
        min < 1 -> "${(min * 60).toInt().coerceAtLeast(1)} sec"
        min < 60 -> "${Math.round(min)} min"
        else -> { val h = (min / 60).toInt(); "${h}h ${Math.round(min - h * 60)}m" }
    }

    private fun normalize(raw: String?): JSONObject {
        val o = try { if (raw.isNullOrEmpty()) JSONObject() else JSONObject(raw) } catch (_: Exception) { JSONObject() }
        if (o.optJSONObject("byKey") == null) o.put("byKey", JSONObject())
        if (o.optJSONObject("totals") == null) o.put("totals", JSONObject())
        return o
    }
}
