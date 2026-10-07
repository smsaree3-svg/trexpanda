package com.lumisha.trexpanda

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate

class ExpanderEngineTest {

    private fun snip(id: String, trigger: String?, repl: String = "", enabled: Boolean = true,
                     deletedAt: Long? = null) =
        Snippet(id = id, trigger = trigger, replacement = repl, enabled = enabled, deletedAt = deletedAt)

    @Test fun firesOnFullTrigger() {
        val e = ExpanderEngine(listOf(snip("1", ";hi", "Hello")))
        assertNull(e.onChar('x'))
        e.onChar(';'); e.onChar('h')
        val a = e.onChar('i')
        assertNotNull(a)
        assertEquals("Hello", a!!.replacement)
        assertEquals(3, a.backspaces)
    }

    @Test fun longestTriggerWins() {
        val e = ExpanderEngine(listOf(snip("1", ";x", "SHORT"), snip("2", "a;x", "LONG")))
        e.onChar('a'); e.onChar(';')
        val a = e.onChar('x')
        assertEquals("LONG", a!!.replacement)
    }

    @Test fun dynamicDateResolves() {
        val e = ExpanderEngine(listOf(snip("1", ";d", "{date}")))
        e.onChar(';')
        val a = e.onChar('d')
        assertEquals(LocalDate.now().toString(), a!!.replacement)
    }

    @Test fun caretMarkerCountsCodePoints() {
        val e = ExpanderEngine(listOf(snip("1", ";c", "ab\$|cd")))
        e.onChar(';')
        val a = e.onChar('c')
        assertEquals("abcd", a!!.replacement)
        assertEquals(2, a.caretBack)

        val e2 = ExpanderEngine(listOf(snip("2", ";e", "x\$|🙂")))
        e2.onChar(';')
        val a2 = e2.onChar('e')
        assertEquals("one astral emoji is a single caret step", 1, a2!!.caretBack)
    }

    @Test fun disabledAndDeletedNeverFire() {
        val e = ExpanderEngine(listOf(snip("1", ";off", "NO", enabled = false),
                                      snip("2", ";del", "NO", deletedAt = 5L)))
        e.onChar(';'); e.onChar('o'); e.onChar('f'); val a1 = e.onChar('f')
        e.reset(); e.onChar(';'); e.onChar('d'); e.onChar('e'); val a2 = e.onChar('l')
        assertNull(a1); assertNull(a2)
    }

    @Test fun suggestionsMatchPartialToken() {
        val e = ExpanderEngine(listOf(snip("1", ";addr", "123 Main"), snip("2", ";addr2", "456 Oak")))
        e.onChar(';'); e.onChar('a'); e.onChar('d')
        val (token, items) = e.suggestions()
        assertEquals(";ad", token)
        assertEquals(2, items.size)
        assertEquals(";addr", items[0].trigger)
    }
}
