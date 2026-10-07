package com.lumisha.trexpanda

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncMergeTest {

    private fun snip(id: String, trigger: String?, repl: String = "", updatedAt: Long = 0L,
                     deletedAt: Long? = null) =
        Snippet(id = id, trigger = trigger, replacement = repl, updatedAt = updatedAt, deletedAt = deletedAt)

    private val now = System.currentTimeMillis()

    @Test fun remoteOnlyAdoptedNotPushed() {
        val r = SyncMerge.merge(emptyList(), emptyList(),
            listOf(snip("a", ";a", "A", updatedAt = now - 1000)), now)
        assertEquals(1, r.live.size)
        assertEquals(";a", r.live[0].trigger)
        assertTrue(r.push.isEmpty())
    }

    @Test fun localOnlyPushed() {
        val r = SyncMerge.merge(listOf(snip("b", ";b", "B", updatedAt = now - 500)),
            emptyList(), emptyList(), now)
        assertEquals(1, r.push.size)
        assertEquals("b", r.push[0].id)
        assertNull(r.push[0].deletedAt)
        assertEquals(1, r.live.size)
    }

    @Test fun newerSideWins() {
        val localWins = SyncMerge.merge(listOf(snip("c", ";c", "NEW", updatedAt = now)),
            emptyList(), listOf(snip("c", ";c", "OLD", updatedAt = now - 1000)), now)
        assertEquals("NEW", localWins.live[0].replacement)
        assertEquals(1, localWins.push.size)

        val remoteWins = SyncMerge.merge(listOf(snip("d", ";d", "OLD", updatedAt = now - 1000)),
            emptyList(), listOf(snip("d", ";d", "NEW", updatedAt = now)), now)
        assertEquals("NEW", remoteWins.live[0].replacement)
        assertTrue(remoteWins.push.isEmpty())
    }

    @Test fun deletionsPropagateBothWays() {
        val remoteDel = SyncMerge.merge(listOf(snip("e", ";e", "X", updatedAt = now - 1000)),
            emptyList(), listOf(snip("e", ";e", "", updatedAt = now, deletedAt = now)), now)
        assertTrue(remoteDel.live.isEmpty())
        assertEquals(1, remoteDel.tombstones.size)
        assertTrue(remoteDel.push.isEmpty())

        val localDel = SyncMerge.merge(emptyList(), listOf(Tombstone("f", ";f", now)),
            listOf(snip("f", ";f", "X", updatedAt = now - 1000)), now)
        assertTrue(localDel.live.isEmpty())
        assertEquals(1, localDel.push.size)
        assertNotNull(localDel.push[0].deletedAt)
    }

    @Test fun expiredTombstonePruned() {
        val old = now - (SyncMerge.TOMBSTONE_TTL_MS + 1000)
        val r = SyncMerge.merge(emptyList(), listOf(Tombstone("g", ";g", old)), emptyList(), now)
        assertTrue(r.tombstones.isEmpty())
    }
}
