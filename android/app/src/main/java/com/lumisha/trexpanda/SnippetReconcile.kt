package com.lumisha.trexpanda

/**
 * Pure reconcile step for the local snippet set — the Kotlin port of the desktop
 * app's `Store.setPersonal` (src/store.js).
 *
 * When the user saves the snippet list from the UI, we must:
 *   - assign a stable id to any brand-new snippet (empty id),
 *   - stamp `updatedAt = now` ONLY when a snippet's content actually changed
 *     (so re-saving an unchanged list doesn't create pointless sync churn),
 *   - leave a tombstone for every snippet that was removed, and
 *   - cancel the tombstone for any id that is being (re-)added.
 *
 * Kept pure (no storage, no Android) so it is unit-testable in plain Kotlin.
 */
object SnippetReconcile {

    data class Out(val live: List<Snippet>, val tombstones: List<Tombstone>)

    fun reconcile(
        current: List<Snippet>,
        currentTombstones: List<Tombstone>,
        incoming: List<Snippet>,
        now: Long = System.currentTimeMillis(),
        idGen: () -> String = { java.util.UUID.randomUUID().toString() },
    ): Out {
        val currentById = current.associateBy { it.id }
        val tombById = currentTombstones.associateBy { it.id }.toMutableMap()

        val outLive = ArrayList<Snippet>(incoming.size)
        val keptIds = HashSet<String>()

        for (inc in incoming) {
            val id = if (inc.id.isBlank()) idGen() else inc.id
            val existing = currentById[id]
            val updatedAt =
                if (existing != null && existing.signature() == inc.copy(id = id).signature()) existing.updatedAt
                else now
            outLive.add(inc.copy(id = id, updatedAt = updatedAt, deletedAt = null))
            keptIds.add(id)
            // Re-adding an id cancels any tombstone for it.
            tombById.remove(id)
        }

        // Anything previously live but not in the incoming set becomes a tombstone.
        for (c in current) {
            if (c.id !in keptIds) {
                tombById[c.id] = Tombstone(c.id, c.trigger, now)
            }
        }

        return Out(outLive, tombById.values.toList())
    }
}
