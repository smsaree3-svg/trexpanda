package com.lumisha.trexpanda

import android.content.Context
import org.json.JSONObject
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
    private val lock = Any()

    private var live: MutableList<Snippet> = mutableListOf()
    private var tombstones: MutableList<Tombstone> = mutableListOf()

    init {
        load()
    }

    private fun load() = synchronized(lock) {
        live = mutableListOf()
        tombstones = mutableListOf()
        if (!file.exists()) return@synchronized
        try {
            val root = JSONObject(file.readText())
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
        file.writeText(root.toString())
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

    companion object {
        private const val FILE_NAME = "snippets.json"
    }
}
