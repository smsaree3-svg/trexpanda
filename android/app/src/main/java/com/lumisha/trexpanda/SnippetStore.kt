package com.lumisha.trexpanda

import android.content.Context
import org.json.JSONObject
import android.util.AtomicFile
import java.io.File

/**
 * Local, offline-first persistence for the user's personal snippets plus the
 * deletion tombstones that cross-device sync needs. Backed by a single JSON file
 * in the app's private storage so the keyboard works with no network.
 *
 * The reconcile/merge brains live in the pure [SnippetReconcile] / [SyncMerge];
 * this class just loads, saves, and applies their results.
 */
class SnippetStore(context: Context) {

    private val file: File = File(context.filesDir, FILE_NAME)
    private val atomic = AtomicFile(file)

    // The in-memory copy and its lock are shared by every SnippetStore in this
    // process (activity, sync thread, keyboard, usage stats). Per-instance copies
    // let a stale instance (e.g. an old activity's sync after a rotation) write
    // its outdated list over newer edits, and per-instance locks didn't stop two
    // instances writing the file at the same time.
    private val lock get() = LOCK
    private var live: MutableList<Snippet>
        get() = sharedLive
        set(v) { sharedLive = v }
    private var tombstones: MutableList<Tombstone>
        get() = sharedTombstones
        set(v) { sharedTombstones = v }

    init {
        load()
    }

    private fun load() = synchronized(lock) {
        loaded = true
        live = mutableListOf()
        tombstones = mutableListOf()
        if (!file.exists()) return@synchronized
        try {
            val root = JSONObject(String(atomic.readFully(), Charsets.UTF_8))
            live = SnippetJson.snippetsFromLocalArray(root.optJSONArray("live") ?: org.json.JSONArray())
                .toMutableList()
            val now = System.currentTimeMillis()
            tombstones = SnippetJson.tombstonesFromArray(root.optJSONArray("tombstones") ?: org.json.JSONArray())
                .filter { now - it.deletedAt <= SyncMerge.TOMBSTONE_TTL_MS }
                .toMutableList()
        } catch (_: Exception) {
            // Corrupt file: start clean rather than crash the keyboard.
            live = mutableListOf()
            tombstones = mutableListOf()
        }
    }

    private fun persist() = synchronized(lock) {
        val root = JSONObject().apply {
            put("live", SnippetJson.snippetsToLocalArray(live))
            put("tombstones", SnippetJson.tombstonesToArray(tombstones))
        }
        // Atomic: readers (keyboard, any-keyboard mode) never see a half-written
        // file, and a crash mid-write can't wipe the user's snippets.
        val out = atomic.startWrite()
        try {
            out.write(root.toString().toByteArray(Charsets.UTF_8))
            atomic.finishWrite(out)
        } catch (e: Exception) {
            atomic.failWrite(out)
            throw e
        }
    }

    /** Forget all local snippets (used when a different account signs in). */
    fun clearAll() = synchronized(lock) {
        live = mutableListOf()
        tombstones = mutableListOf()
        persist()
    }

    /** The current live snippets (what the keyboard expands and the UI lists). */
    fun getPersonal(): List<Snippet> = synchronized(lock) { live.toList() }

    fun getTombstones(): List<Tombstone> = synchronized(lock) { tombstones.toList() }

    /**
     * Save the snippet list coming from the UI. Assigns ids to new snippets,
     * only bumps `updatedAt` when content changed, and tombstones removals.
     */
    fun setPersonal(incoming: List<Snippet>) = synchronized(lock) {
        val out = SnippetReconcile.reconcile(live, tombstones, incoming)
        live = out.live.toMutableList()
        tombstones = out.tombstones.toMutableList()
        persist()
    }

    /** Apply the result of a cloud sync merge. */
    fun applySynced(newLive: List<Snippet>, newTombstones: List<Tombstone>) = synchronized(lock) {
        live = newLive.toMutableList()
        tombstones = newTombstones.toMutableList()
        persist()
    }

    /**
     * Merge [remote] into the CURRENT local state and save, atomically: an edit
     * saved from the UI while a sync is running can't be overwritten by a merge
     * computed from the list as it was a moment earlier.
     */
    fun mergeRemote(remote: List<Snippet>): SyncMerge.Result = synchronized(lock) {
        val merged = SyncMerge.merge(live = live.toList(), tombstones = tombstones.toList(), remote = remote)
        live = merged.live.toMutableList()
        tombstones = merged.tombstones.toMutableList()
        persist()
        merged
    }

    companion object {
        private const val FILE_NAME = "snippets.json"

        private val LOCK = Any()
        private var sharedLive: MutableList<Snippet> = mutableListOf()
        private var sharedTombstones: MutableList<Tombstone> = mutableListOf()
        private var loaded = false

        /**
         * The live snippets without re-reading the file when this process already
         * has them (cheap enough to call on every expansion).
         */
        fun peekPersonal(context: Context): List<Snippet> = synchronized(LOCK) {
            if (!loaded) return@synchronized SnippetStore(context).getPersonal()
            sharedLive.toList()
        }
    }
}
