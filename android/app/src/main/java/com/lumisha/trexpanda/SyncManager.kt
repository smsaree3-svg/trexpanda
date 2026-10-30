package com.lumisha.trexpanda

import android.content.Context
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Orchestrates one cross-device sync cycle: pull the caller's rows from Supabase,
 * merge them with the local live set + tombstones via the pure [SyncMerge]
 * (last-write-wins, tombstones both ways), apply the result locally, and push
 * back whatever this device won.
 *
 * Safe to call opportunistically (app open, after an edit, pull-to-refresh);
 * overlapping calls are coalesced.
 */
class SyncManager(
    context: Context,
    private val auth: AuthManager,
    private val store: SnippetStore,
    private val cloud: SupabaseClient = SupabaseClient(auth),
) {
    private val appContext = context.applicationContext
    private val io = Executors.newSingleThreadExecutor()
    private val running = AtomicBoolean(false)
    // A sync asked for while one is running (e.g. the user saved an edit right
    // after the app opened) must still happen, or that edit is never pushed.
    private val rerun = AtomicBoolean(false)
    @Volatile private var rerunDone: Callback? = null

    fun interface Callback {
        fun onResult(success: Boolean, message: String?)
    }

    /** Run a sync on a background thread. [done] is invoked on the same thread. */
    fun sync(done: Callback? = null) {
        if (!auth.isSignedIn || !SupabaseConfig.isConfigured()) {
            done?.onResult(false, "Sign in to sync.")
            return
        }
        if (!running.compareAndSet(false, true)) {
            if (done != null) rerunDone = done
            rerun.set(true)
            done?.onResult(false, "Sync already in progress.")
            return
        }
        try {
            io.execute { runOnce(done) }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            running.set(false) // closed
        }
    }

    /** Stop the worker thread once any sync in progress finishes (activity destroyed). */
    fun close() {
        io.shutdown()
    }

    private fun runOnce(done: Callback?) {
        try {
            val remote = cloud.pullSnippets()
            // Merge against the local list as it is NOW (atomically), not a
            // copy read earlier, so a concurrent edit isn't overwritten.
            val merged = store.mergeRemote(remote)
            val pushed = cloud.pushSnippets(merged.push)
            Log.i(TAG, "sync ok: pulled=${remote.size} pushed=$pushed live=${merged.live.size}")
            try {
                // Use counts and time saved, combined across every device.
                val dev = UsageStats.deviceId(appContext)
                val local = UsageStats.local(appContext)
                cloud.pushUsage(dev, local)
                UsageStats.saveCombined(appContext, UsageStats.combine(local, cloud.pullUsage(), dev))
            } catch (e: Exception) {
                Log.w(TAG, "usage sync failed", e)
            }
            done?.onResult(true, "Synced (${merged.live.size} snippets).")
        } catch (e: Exception) {
            Log.w(TAG, "sync failed", e)
            done?.onResult(false, if (e.message == "Not signed in.") "Sign in to sync." else "Sync failed. Check your connection and try again.")
        } finally {
            running.set(false)
            if (rerun.getAndSet(false) && !io.isShutdown) {
                val next = rerunDone
                rerunDone = null
                sync(next)
            }
        }
    }

    companion object {
        private const val TAG = "TrexpandaSync"
    }
}
