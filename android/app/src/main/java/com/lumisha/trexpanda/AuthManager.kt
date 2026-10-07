package com.lumisha.trexpanda

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import android.util.Base64

/**
 * Google sign-in through Supabase GoTrue using the OAuth 2.0 PKCE flow.
 *
 * Flow:
 *   1. [startGoogleSignIn] generates a PKCE verifier/challenge, opens the
 *      provider's authorize URL in a Chrome Custom Tab.
 *   2. GoTrue redirects back to `trexpanda://auth?code=...`, caught by
 *      [AuthRedirectActivity], which calls [completeSignIn].
 *   3. [completeSignIn] exchanges the code for a session (access + refresh
 *      tokens) and stores it.
 *
 * Tokens are kept in SharedPreferences. For production, swap this for
 * EncryptedSharedPreferences (androidx.security-crypto) — kept as plain prefs
 * here to keep the dependency surface small; see README.
 */
class AuthManager(private val context: Context) {

    private val prefs = context.getSharedPreferences("trexpanda_auth", Context.MODE_PRIVATE)
    private val http = OkHttpClient()

    val isSignedIn: Boolean get() = accessToken != null && userId != null

    val accessToken: String? get() = prefs.getString(KEY_ACCESS, null)
    val refreshToken: String? get() = prefs.getString(KEY_REFRESH, null)
    val userId: String? get() = prefs.getString(KEY_USER_ID, null)
    val userEmail: String? get() = prefs.getString(KEY_EMAIL, null)
    private val expiresAt: Long get() = prefs.getLong(KEY_EXPIRES_AT, 0L)

    /** Build the authorize URL, stash the verifier, and launch a Custom Tab. */
    fun startGoogleSignIn() {
        val verifier = randomUrlSafe(64)
        prefs.edit().putString(KEY_VERIFIER, verifier).apply()
        val challenge = codeChallenge(verifier)

        val authorize = Uri.parse(SupabaseConfig.authUrl("authorize")).buildUpon()
            .appendQueryParameter("provider", "google")
            .appendQueryParameter("redirect_to", SupabaseConfig.REDIRECT_URI)
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("code_challenge_method", "s256")
            .build()

        val tab = CustomTabsIntent.Builder().build()
        tab.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        tab.launchUrl(context, authorize)
    }

    /** Exchange the `?code=` from the redirect for a session. Returns true on success. */
    fun completeSignIn(redirect: Uri): Boolean {
        val code = redirect.getQueryParameter("code") ?: return false
        val verifier = prefs.getString(KEY_VERIFIER, null) ?: return false

        val body = JSONObject()
            .put("auth_code", code)
            .put("code_verifier", verifier)
            .toString()
            .toRequestBody(JSON)

        val req = Request.Builder()
            .url(SupabaseConfig.authUrl("token?grant_type=pkce"))
            .addHeader("apikey", SupabaseConfig.anonKey)
            .addHeader("Content-Type", "application/json")
            .post(body)
            .build()

        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return false
            val json = JSONObject(resp.body?.string() ?: return false)
            storeSession(json)
        }
        prefs.edit().remove(KEY_VERIFIER).apply()
        return true
    }

    /** A valid access token, refreshing first if it is near expiry. Null if signed out. */
    @Synchronized
    fun freshAccessToken(): String? {
        if (!isSignedIn) return null
        if (System.currentTimeMillis() < expiresAt - 60_000) return accessToken
        return if (refresh()) accessToken else null
    }

    private fun refresh(): Boolean {
        val rt = refreshToken ?: return false
        val body = JSONObject().put("refresh_token", rt).toString().toRequestBody(JSON)
        val req = Request.Builder()
            .url(SupabaseConfig.authUrl("token?grant_type=refresh_token"))
            .addHeader("apikey", SupabaseConfig.anonKey)
            .addHeader("Content-Type", "application/json")
            .post(body)
            .build()
        return try {
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return false
                storeSession(JSONObject(resp.body?.string() ?: return false))
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    fun signOut() {
        prefs.edit().clear().apply()
    }

    private fun storeSession(json: JSONObject) {
        val access = json.optString("access_token", "")
        val refresh = json.optString("refresh_token", "")
        val expiresIn = json.optLong("expires_in", 3600L)
        val user = json.optJSONObject("user")
        prefs.edit()
            .putString(KEY_ACCESS, access)
            .putString(KEY_REFRESH, refresh)
            .putLong(KEY_EXPIRES_AT, System.currentTimeMillis() + expiresIn * 1000L)
            .apply {
                if (user != null) {
                    putString(KEY_USER_ID, user.optString("id", null))
                    putString(KEY_EMAIL, user.optString("email", null))
                }
            }
            .apply()
    }

    // ---- PKCE helpers --------------------------------------------------------

    private fun randomUrlSafe(bytes: Int): String {
        val b = ByteArray(bytes)
        SecureRandom().nextBytes(b)
        return Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private fun codeChallenge(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
        return Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private const val KEY_ACCESS = "access_token"
        private const val KEY_REFRESH = "refresh_token"
        private const val KEY_EXPIRES_AT = "expires_at"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_EMAIL = "email"
        private const val KEY_VERIFIER = "pkce_verifier"
    }
}
