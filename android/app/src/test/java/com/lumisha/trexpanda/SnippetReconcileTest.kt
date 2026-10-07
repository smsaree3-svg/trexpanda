package com.lumisha.trexpanda

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SnippetReconcileTest {

    private fun snip(id: String, trigger: String?, repl: String = "") =
        Snippet(id = id, trigger = trigger, replacement = repl)

    @Test fun assignsIdsStampsTimestampsAndTombstones() {
        var seq = 0
        val idGen = { "id-" + (++seq) }

        val r1 = SnippetReconcile.reconcile(emptyList(), emptyList(),
            listOf(snip("", ";a", "A")), now = 1000, idGen = idGen)
        assertEquals(1, r1.live.size)
        assertTrue(r1.live[0].id.isNotBlank())
        assertEquals(1000L, r1.live[0].updatedAt)
        val id = r1.live[0].id

        // Unchanged re-save keeps the timestamp.
        val r2 = SnippetReconcile.reconcile(r1.live, r1.tombstones, r1.live, now = 2000, idGen = idGen)
        assertEquals(1000L, r2.live[0].updatedAt)

        // Editing content bumps the timestamp.
        val r3 = SnippetReconcile.reconcile(r2.live, r2.tombstones,
            listOf(snip(id, ";a", "A2")), now = 3000, idGen = idGen)
        assertEquals(3000L, r3.live[0].updatedAt)

        // Deleting leaves a tombstone.
        val r4 = SnippetReconcile.reconcile(r3.live, r3.tombstones, emptyList(), now = 4000, idGen = idGen)
        assertTrue(r4.live.isEmpty())
        assertEquals(1, r4.tombstones.size)
        assertEquals(id, r4.tombstones[0].id)

        // Re-adding the same id cancels the tombstone.
        val r5 = SnippetReconcile.reconcile(r4.live, r4.tombstones,
            listOf(snip(id, ";a", "A")), now = 5000, idGen = idGen)
        assertTrue(r5.tombstones.isEmpty())
        assertEquals(1, r5.live.size)
    }
}
