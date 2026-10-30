package com.lumisha.trexpanda

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Live updates. Subscribes to Supabase Realtime (Postgres changes on the
 * `snippets` table, scoped to this user by RLS) over a WebSocket, so a snippet
 * created or edited anywhere — the desktop app, a future web app — is pushed to
 * the phone within a moment and triggers a sync. No polling.
 *
 * Protocol: Supabase Realtime speaks the Phoenix channels protocol. We join a
 * channel configured for `postgres_changes` on our table, heartbeat to keep the
 * socket alive, and on any change event fire [onChange] (which runs a sync). We
 * don't need the change payload itself — any event means "pull and merge".
 */
class RealtimeClient(
    private val auth: AuthManager,
    private val onChange: () -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val ref = AtomicInteger(0)

    @Volatile private var ws: WebSocket? = null
    @Volatile private var active = false
    @Volatile private var joined = false
    private var reconnectDelayMs = 2000L

    private val heartbeat = object : Runnable {
        override fun run() {
            val sock = ws ?: return
            send(sock, "phoenix", "heartbeat", JSONObject())
            main.postDelayed(this, 25_000)
        }
    }

    fun start() {
        if (active) return
        if (!auth.isSignedIn || !SupabaseConfig.isConfigured()) return
        active = true
        connect()
    }

    fun stop() {
        active = false
        joined = false
        main.removeCallbacks(heartbeat)
        try { ws?.close(1000, "bye") } catch (_: Exception) {}
        ws = null
    }

    /** Stop for good and release the worker thread (owner destroyed). */
    fun close() {
        stop()
        io.shutdown()
    }

    private fun connect() {
        if (!active) return
        // Token refresh is a network call: never on the main thread.
        if (io.isShutdown) return
        io.execute {
            if (!active) return@execute
            val token = auth.freshAccessToken()
            if (token == null) { main.post { scheduleReconnect() }; return@execute }
            val base = SupabaseConfig.url.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
            val url = "$base/realtime/v1/websocket?apikey=${SupabaseConfig.anonKey}&vsn=1.0.0"
            val req = Request.Builder().url(url).build()
            main.post {
                if (!active || ws != null) return@post
                ws = client.newWebSocket(req, Listener(token))
            }
        }
    }

    private fun scheduleReconnect() {
        if (!active) return
        joined = false
        ws = null
        main.removeCallbacks(heartbeat)
        main.postDelayed({ connect() }, reconnectDelayMs)
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000)
    }

    private fun send(sock: WebSocket, topic: String, event: String, payload: JSONObject) {
        val msg = JSONObject()
            .put("topic", topic)
            .put("event", event)
            .put("payload", payload)
            .put("ref", ref.incrementAndGet().toString())
        sock.send(msg.toString())
    }

    private inner class Listener(private val token: String) : WebSocketListener() {
        private val topic = "realtime:public:snippets"

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (webSocket !== ws) { webSocket.cancel(); return } // a stale socket
            // The back-off is reset only once the channel join is accepted (see
            // phx_reply): a server that accepts the socket but rejects the channel
            // would otherwise get a reconnect + full sync every 2 seconds forever.
            val uid = auth.userId ?: return
            val changes = org.json.JSONArray().put(
                JSONObject()
                    .put("event", "*")
                    .put("schema", "public")
                    .put("table", "snippets")
                    .put("filter", "user_id=eq.$uid")
            )
            val payload = JSONObject()
                .put("config", JSONObject().put("postgres_changes", changes).put("private", false))
                .put("access_token", token)
            send(webSocket, topic, "phx_join", payload)
            main.removeCallbacks(heartbeat)
            main.postDelayed(heartbeat, 25_000)
            // Pull once on (re)connect so we never miss a change made while offline.
            onChange()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            try {
                val msg = JSONObject(text)
                val event = msg.optString("event")
                when (event) {
                    "phx_reply" -> if (msg.optString("topic") == topic) {
                        val status = msg.optJSONObject("payload")?.optString("status")
                        if (status == "ok") {
                            joined = true
                            main.post { reconnectDelayMs = 2000L }
                        } else if (webSocket === ws) {
                            // Join refused (e.g. expired token): reconnect with a fresh one.
                            webSocket.cancel()
                            main.post { scheduleReconnect() }
                        }
                    }
                    "postgres_changes" -> if (webSocket === ws) onChange()
                    "phx_error", "phx_close" -> if (webSocket === ws) {
                        webSocket.cancel()
                        main.post { scheduleReconnect() }
                    }
                }
            } catch (_: Exception) { /* ignore malformed frames */ }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "realtime failure", t)
            if (webSocket === ws) main.post { scheduleReconnect() }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // The server is closing: finish the handshake so onClosed fires and we
            // reconnect, instead of sitting on a half-closed socket.
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (webSocket === ws && active) main.post { scheduleReconnect() }
        }
    }

    companion object {
        private const val TAG = "TrexpandaRealtime"
    }
}
