package com.lumisha.trexpanda

import android.content.Context

/**
 * Supabase connection settings.
 *
 * The project URL and the anon (public) key are NOT secrets — they ship inside
 * client apps; all real access control is enforced by Row Level Security on the
 * `snippets` table.
 *
 * Resolution order (first non-blank wins):
 *   1. Values saved in-app (Cloud settings) — lets you enable sync on a build
 *      that shipped without keys baked in, which is how the debug build works.
 *   2. [BuildConfig] values injected from local.properties at build time — the
 *      right choice for a public release so end users never see a config screen.
 *
 * The OAuth redirect must be allow-listed in the Supabase dashboard under
 * Authentication -> URL Configuration -> Redirect URLs.
 */
object SupabaseConfig {

    private const val PREFS = "trexpanda_cfg"
    private const val KEY_URL = "supabase_url"
    private const val KEY_ANON = "supabase_anon"

    @Volatile private var urlOverride: String? = null
    @Volatile private var anonOverride: String? = null

    const val REDIRECT_URI = "trexpanda://auth"

    /** Default URL baked at build time, shown pre-filled in Cloud settings. */
    val defaultUrl: String get() = BuildConfig.SUPABASE_URL

    val url: String get() = (urlOverride?.takeIf { it.isNotBlank() } ?: BuildConfig.SUPABASE_URL).trimEnd('/')
    val anonKey: String get() = anonOverride?.takeIf { it.isNotBlank() } ?: BuildConfig.SUPABASE_ANON_KEY

    fun isConfigured(): Boolean = url.isNotBlank() && anonKey.isNotBlank()

    fun authUrl(path: String) = "$url/auth/v1/$path"
    fun restUrl(path: String) = "$url/rest/v1/$path"

    /** Load any in-app overrides. Call early (app / IME start). */
    fun load(context: Context) {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        urlOverride = p.getString(KEY_URL, null)
        anonOverride = p.getString(KEY_ANON, null)
    }

    /** Save in-app Supabase settings and apply them immediately. */
    fun save(context: Context, url: String, anonKey: String) {
        urlOverride = url.trim()
        anonOverride = anonKey.trim()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_URL, urlOverride)
            .putString(KEY_ANON, anonOverride)
            .apply()
    }

    /** The currently saved URL (override, or the baked default) for pre-filling the form. */
    fun currentUrl(): String = urlOverride?.takeIf { it.isNotBlank() } ?: BuildConfig.SUPABASE_URL
    fun currentAnonKey(): String = anonOverride ?: ""
}
