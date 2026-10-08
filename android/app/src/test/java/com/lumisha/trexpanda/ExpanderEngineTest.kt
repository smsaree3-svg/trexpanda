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

    @Test fun triggerMatchesRegardlessOfCase() {
        val e = ExpanderEngine(listOf(snip("1", ";ch", "Chennai")))
        // Mixed case typed via onChar
        e.onChar(';'); e.onChar('C')
        val a = e.onChar('H')
        assertNotNull(a)
        assertEquals("Chennai", a!!.replacement)
        assertEquals(";ch", a.trigger)   // canonical stored form
        assertEquals(3, a.backspaces)
    }

    @Test fun matchSuffixIsCaseInsensitive() {
        val e = ExpanderEngine(listOf(snip("1", ";brb", "be right back")))
        val a = e.matchSuffix("ok ;BRB")
        assertNotNull(a)
        assertEquals("be right back", a!!.replacement)
        assertEquals(";brb", a.trigger)
    }

    @Test fun upperCaseStoredTriggerMatchesLowerTyping() {
        val e = ExpanderEngine(listOf(snip("1", ";GM", "Good morning")))
        val a = e.matchSuffix("hey ;gm")
        assertNotNull(a)
        assertEquals("Good morning", a!!.replacement)
    }

    @Test fun suggestionsAreCaseInsensitive() {
        val e = ExpanderEngine(listOf(snip("1", ";Addr", "123 Main")))
        val (token, items) = e.suggestionsFrom("hi ;AD")
        assertEquals(";AD", token)
        assertEquals(1, items.size)
        assertEquals(";Addr", items[0].trigger)
    }

    // ---- spec edge cases ----

    @Test fun unknownTokenIsLeftUntouched() {
        val e = ExpanderEngine(listOf(snip("1", ";v", "Hi {name}, on {date}")))
        val a = e.matchSuffix(";v")
        assertNotNull(a)
        assertEquals(true, a!!.replacement.startsWith("Hi {name}, on "))
        assertEquals(true, Regex("\\d{4}-\\d{2}-\\d{2}$").containsMatchIn(a.replacement))
    }

    @Test fun everyKnownTokenOccurrenceReplaced() {
        val e = ExpanderEngine(listOf(snip("1", ";d2", "{date} to {date}")))
        val a = e.matchSuffix(";d2")!!
        val parts = a.replacement.split(" to ")
        assertEquals(2, parts.size)
        assertEquals(parts[0], parts[1])
        assertEquals(true, Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(parts[0]))
    }

    @Test fun emptyReplacementStillDeletesTrigger() {
        val e = ExpanderEngine(listOf(snip("1", ";x", "")))
        val a = e.matchSuffix(";x")
        assertNotNull(a)
        assertEquals("", a!!.replacement)
        assertEquals(2, a.backspaces)
    }

    @Test fun duplicateTriggerLastWins() {
        val e = ExpanderEngine(listOf(snip("1", ";dup", "first"), snip("2", ";dup", "second")))
        assertEquals("second", e.matchSuffix(";dup")!!.replacement)
    }

    @Test fun duplicateTriggerCaseInsensitiveLastWins() {
        // SPEC V4: ";test"->First then ";TEST"->Second collapse to one trigger; last wins.
        val e = ExpanderEngine(listOf(snip("1", ";test", "First"), snip("2", ";TEST", "Second")))
        assertEquals("Second", e.matchSuffix("go ;test")!!.replacement)
        assertEquals("Second", e.matchSuffix("go ;TEST")!!.replacement)
    }

    @Test fun multipleCursorMarkersFirstWinsAllStripped() {
        // SPEC V8
        val e = ExpanderEngine(listOf(snip("1", ";m2", "Hello \$|world \$|")))
        val a = e.matchSuffix(";m2")!!
        assertEquals("Hello world ", a.replacement)
        assertEquals("world ".length, a.caretBack)
    }

    @Test fun multilineAndUnicodeVerbatim() {
        val e = ExpanderEngine(listOf(snip("1", ";m", "Line 1\nLíne 2 ✨\n日本語")))
        assertEquals("Line 1\nLíne 2 ✨\n日本語", e.matchSuffix(";m")!!.replacement)
    }
}
