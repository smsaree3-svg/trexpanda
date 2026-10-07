package com.lumisha.trexpanda

/**
 * Pure cross-device merge — the Kotlin port of the desktop app's
 * `mergeSnippetsForSync` (src/store.js).
 *
 * Given the device's live snippets, its local deletion tombstones, and the rows
 * pulled from Supabase, it decides per id who wins by `updatedAt`
 * (last-write-wins, ties go to the remote), produces the new local live set and
 * tombstone set, and the list of rows this device must push back up.
 *
 * Deletions propagate both ways: a remote deletion that is newer removes the
 * local live snippet (and is kept as a tombstone within the TTL); a local
 * deletion that is newer is pushed so the row doesn't resurrect elsewhere.
 * Tombstones older than [TOMBSTONE_TTL_MS] are pruned.
 */
object SyncMerge {

    const val TOMBSTONE_TTL_MS: Long = 120L * 24 * 60 * 60 * 1000 // 120 days

    data class Result(
        val live: List<Snippet>,
        val tombstones: List<Tombstone>,
        /** Rows to upsert to Supabase. A row with `deletedAt != null` is a deletion. */
        val push: List<Snippet>,
    )

    private data class LocalState(
        val dead: Boolean,
        val ts: Long,
        val snippet: Snippet?,
        val tombstone: Tombstone?,
    )

    fun merge(
        live: List<Snippet>,
        tombstones: List<Tombstone>,
        remote: List<Snippet>,
        now: Long = System.currentTimeMillis(),
    ): Result {
        val localById = HashMap<String, LocalState>()
        for (s in live) {
            localById[s.id] = LocalState(dead = false, ts = s.updatedAt, snippet = s, tombstone = null)
        }
        for (t in tombstones) {
            val existing = localById[t.id]
            // If a live snippet and a tombstone share an id, the newer one wins.
            if (existing == null || t.deletedAt > existing.ts) {
                localById[t.id] = LocalState(dead = true, ts = t.deletedAt, snippet = null, tombstone = t)
            }
        }

        val remoteById = remote.associateBy { it.id }
        val ids = LinkedHashSet<String>().apply {
            addAll(localById.keys)
            addAll(remoteById.keys)
        }

        val newLive = ArrayList<Snippet>()
        val newTombs = ArrayList<Tombstone>()
        val push = ArrayList<Snippet>()

        fun keepTomb(t: Tombstone, nowMs: Long) {
            if (nowMs - t.deletedAt <= TOMBSTONE_TTL_MS) newTombs.add(t)
        }

        for (id in ids) {
            val l = localById[id]
            val r = remoteById[id]

            when {
                l == null && r != null -> {
                    // No local record: adopt the remote state. Never push.
                    if (r.isDeleted) keepTomb(Tombstone(id, r.trigger, r.deletedAt!!), now)
                    else newLive.add(r)
                }

                l != null && r == null -> {
                    // Remote has never seen this id: push the local state up.
                    if (l.dead) {
                        keepTomb(l.tombstone!!, now)
                        push.add(deletionRow(l.tombstone))
                    } else {
                        newLive.add(l.snippet!!)
                        push.add(l.snippet)
                    }
                }

                l != null && r != null -> {
                    val remoteTs = r.deletedAt ?: r.updatedAt
                    if (l.ts > remoteTs) {
                        // Local is newer -> local wins, push it.
                        if (l.dead) {
                            keepTomb(l.tombstone!!, now)
                            push.add(deletionRow(l.tombstone))
                        } else {
                            newLive.add(l.snippet!!)
                            push.add(l.snippet)
                        }
                    } else {
                        // Remote is newer (ties go to remote) -> adopt it, no push.
                        if (r.isDeleted) keepTomb(Tombstone(id, r.trigger, r.deletedAt!!), now)
                        else newLive.add(r)
                    }
                }
            }
        }

        return Result(live = newLive, tombstones = newTombs, push = push)
    }

    private fun deletionRow(t: Tombstone): Snippet =
        Snippet(
            id = t.id,
            trigger = t.trigger,
            replacement = "",
            updatedAt = t.deletedAt,
            deletedAt = t.deletedAt,
        )
}
