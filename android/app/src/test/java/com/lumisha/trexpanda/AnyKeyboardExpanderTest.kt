package com.lumisha.trexpanda

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AnyKeyboardExpanderTest {

    private fun engine(vararg pairs: Pair<String, String>) = ExpanderEngine().apply {
        setSnippets(pairs.mapIndexed { i, (t, r) -> Snippet(id = "id$i", trigger = t, replacement = r) })
    }

    @Test fun expandsTriggerAtEnd() {
        val e = AnyKeyboardExpander.expand(engine(",ch" to "Checking."), "Hi ,ch", 6)!!
        assertEquals("Hi Checking.", e.text)
        assertEquals(12, e.caret)
    }

    @Test fun keepsTextAfterTheCaret() {
        val e = AnyKeyboardExpander.expand(engine(",gm" to "Good morning team!"), "x ,gm tail", 5)!!
        assertEquals("x Good morning team! tail", e.text)
        assertEquals(20, e.caret)
    }

    @Test fun caretMarkerPlacesCursor() {
        val e = AnyKeyboardExpander.expand(engine(";ty" to "Thanks \$|!"), ";ty", 3)!!
        assertEquals("Thanks !", e.text)
        assertEquals(7, e.caret)
    }

    @Test fun noTriggerNoEdit() {
        assertNull(AnyKeyboardExpander.expand(engine(",ch" to "Checking."), "hello", 5))
        assertNull(AnyKeyboardExpander.expand(engine(",ch" to "Checking."), ",ch", 2)) // caret mid-trigger
    }

    @Test fun graphemeAwareCaret() {
        assertEquals(2, AnyKeyboardExpander.charsForLastGraphemes("ab😀", 1))
        assertEquals(0, AnyKeyboardExpander.charsForLastGraphemes("abc", 0))
    }

    @Test fun tokenAndWhenToSuggest() {
        assertEquals(",c", AnyKeyboardExpander.currentToken("hi ,c", 5))
        assertEquals("", AnyKeyboardExpander.currentToken("hi ", 3))
        assertEquals(true, AnyKeyboardExpander.shouldSuggest(";a"))
        assertEquals(false, AnyKeyboardExpander.shouldSuggest("hi"))   // plain short word
        assertEquals(true, AnyKeyboardExpander.shouldSuggest("git"))
        assertEquals(false, AnyKeyboardExpander.shouldSuggest(""))
    }

    @Test fun tappedSuggestionReplacesThePartialTrigger() {
        val e = AnyKeyboardExpander.applySuggestion(engine(",ch" to "Checking."), "ok ,c tail", 5, ",ch")!!
        assertEquals("ok Checking. tail", e.text)
        assertEquals(12, e.caret)
    }
}
