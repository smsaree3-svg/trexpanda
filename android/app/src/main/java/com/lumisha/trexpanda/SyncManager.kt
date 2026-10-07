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
            done?.onResult(false, "Sync already in progress.")
            return
        }
        io.execute {
            try {
                val remote = cloud.pullSnippets()
                val merged = SyncMerge.merge(
                    live = store.getPersonal(),
                    tombstones = store.getTombstones(),
                    remote = remote,
                )
                store.applySynced(merged.live, merged.tombstones)
                val pushed = cloud.pushSnippets(merged.push)
                Log.i(TAG, "sync ok: pulled=${remote.size} pushed=$pushed live=${merged.live.size}")
                done?.onResult(true, "Synced (${merged.live.size} snippets).")
            } catch (e: Exception) {
                Log.w(TAG, "sync failed", e)
                done?.onResult(false, e.message ?: "Sync failed.")
            } finally {
                running.set(false)
            }
        }
    }

    companion object {
        private const val TAG = "TrexpandaSync"
    }
}
