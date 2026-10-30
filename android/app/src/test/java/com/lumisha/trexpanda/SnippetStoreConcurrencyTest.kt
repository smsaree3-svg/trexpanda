package com.lumisha.trexpanda

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SnippetStoreConcurrencyTest {

    private fun ctx() = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun staleInstanceDoesNotOverwriteNewerEdit() {
        val old = SnippetStore(ctx())          // e.g. held by a sync from a destroyed activity
        old.setPersonal(emptyList())
        val fresh = SnippetStore(ctx())        // the current activity
        fresh.setPersonal(listOf(Snippet(id = "", trigger = ";new", replacement = "New")))

        // The old instance's sync merges an empty remote: the new snippet must survive.
        val merged = old.mergeRemote(emptyList())
        assertTrue(merged.live.any { it.trigger == ";new" })
        assertEquals(listOf(";new"), SnippetStore(ctx()).getPersonal().map { it.trigger })
    }

    @Test
    fun mergeRemoteKeepsEditMadeAfterPull() {
        val store = SnippetStore(ctx())
        store.setPersonal(listOf(Snippet(id = "a", trigger = ";a", replacement = "A")))
        val remote = listOf(Snippet(id = "r", trigger = ";r", replacement = "R", updatedAt = 1L))
        // The user saves an edit between the pull and the merge.
        store.setPersonal(store.getPersonal() + Snippet(id = "", trigger = ";b", replacement = "B"))
        val merged = store.mergeRemote(remote)
        assertEquals(setOf(";a", ";b", ";r"), merged.live.map { it.trigger }.toSet())
        assertEquals(setOf(";a", ";b"), merged.push.map { it.trigger }.toSet())
    }

    @Test
    fun usageFromOtherProcessIsRecordedThroughProvider() {
        val c = ctx()
        Robolectric.setupContentProvider(UsageProvider::class.java, UsageProvider.authority(c))
        UsageStats.reset(c)
        UsageProvider.record(c, ";x", 2, 10)
        UsageProvider.record(c, ";x", 2, 10)
        val u = UsageStats.local(c)
        assertEquals(2L, u.getJSONObject("totals").getLong("expansions"))
        assertEquals(16L, u.getJSONObject("totals").getLong("savedChars"))
    }
}
