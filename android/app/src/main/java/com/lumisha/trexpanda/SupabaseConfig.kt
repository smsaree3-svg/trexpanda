package com.lumisha.trexpanda

/**
 * Supabase connection settings.
 *
 * The project URL and the anon (public) key are NOT secrets — they are meant to
 * ship inside client apps; all real access control is enforced by the Row Level
 * Security policies on the `snippets` table. They are injected at build time from
 * `local.properties` into [BuildConfig] (see app/build.gradle.kts), so no keys
 * are hard-coded in source.
 *
 * The OAuth redirect must be allow-listed in the Supabase dashboard under
 * Authentication -> URL Configuration -> Redirect URLs.
 */
object SupabaseConfig {
    val url: String get() = BuildConfig.SUPABASE_URL.trimEnd('/')
    val anonKey: String get() = BuildConfig.SUPABASE_ANON_KEY

    const val REDIRECT_URI = "trexpanda://auth"

    fun isConfigured(): Boolean = url.isNotBlank() && anonKey.isNotBlank()

    fun authUrl(path: String) = "$url/auth/v1/$path"
    fun restUrl(path: String) = "$url/rest/v1/$path"
}
