package com.lumisha.trexpanda

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate

/**
 * ExpansionSpecificationV1 — the canonical cross-platform conformance suite.
 *
 * These are CONTRACTUAL behaviors from SPEC-EXPANSION.md, not incidental
 * implementation tests. The desktop (test/expansion-spec-v1.test.js) and iOS
 * (ExpansionSpecificationV1Tests.swift) suites assert the exact same vectors with
 * the exact same expected results. Do not weaken these to make a change pass;
 * fix the implementation, or raise a spec defect.
 */
class ExpansionSpecificationV1Test {

    private fun snip(trigger: String?, repl: String = "", enabled: Boolean = true, deletedAt: Long? = null) =
        Snippet(id = trigger ?: "x", trigger = trigger, replacement = repl, enabled = enabled, deletedAt = deletedAt)
    private fun eng(vararg s: Snippet) = ExpanderEngine(s.toList())

    @Test fun v1_caseInsensitive() {
        val a = eng(snip(";ch", "Hello")).matchSuffix("Please ;CH")!!
        assertEquals("Hello", a.replacement); assertEquals(3, a.backspaces)
    }

    @Test fun v2_longestMatch() {
        val a = eng(snip(";a", "short"), snip("x;a", "long")).matchSuffix("test x;a")!!
        assertEquals("x;a", a.trigger); assertEquals(3, a.backspaces); assertEquals("long", a.replacement)
    }

    @Test fun v3_canonicalTrigger() {
        assertEquals(";CH", eng(snip(";CH", "Hello")).matchSuffix("hi ;ch")!!.trigger)
    }

    @Test fun v4_duplicateCaseInsensitiveLastWins() {
        val e = eng(snip(";test", "First"), snip(";TEST", "Second"))
        assertEquals("Second", e.matchSuffix("go ;test")!!.replacement)
        assertEquals("Second", e.matchSuffix("go ;TEST")!!.replacement)
    }

    @Test fun v5_unknownTokenUntouched() {
        assertEquals(true, eng(snip(";v", "Hello {name}")).matchSuffix(";v")!!.replacement == "Hello {name}")
    }

    @Test fun v6_multipleTokensResolve() {
        val r = eng(snip(";t", "Date: {date} Time: {time} Full: {datetime}")).matchSuffix(";t")!!.replacement
        assertEquals(true, Regex("Date: \\d{4}-\\d{2}-\\d{2} Time: \\d{2}:\\d{2} Full: \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}").containsMatchIn(r))
    }

    @Test fun v6b_dateIsLocal() {
        assertEquals(LocalDate.now().toString(), eng(snip(";d", "{date}")).matchSuffix(";d")!!.replacement)
    }

    @Test fun v7_cursorMarker() {
        val a = eng(snip(";sig", "Dear \$|,\nRegards")).matchSuffix(";sig")!!
        assertEquals("Dear ,\nRegards", a.replacement); assertEquals(",\nRegards".length, a.caretBack)
    }

    @Test fun v8_multipleMarkersFirstWinsAllStripped() {
        val a = eng(snip(";m", "Hello \$|world \$|")).matchSuffix(";m")!!
        assertEquals("Hello world ", a.replacement); assertEquals("world ".length, a.caretBack)
    }

    @Test fun v9_emptyReplacementDeletesTrigger() {
        val a = eng(snip(";delete", "")).matchSuffix(";delete")!!
        assertEquals("", a.replacement); assertEquals(7, a.backspaces)
    }

    @Test fun v10_unknownTokenUnderscore() {
        assertEquals("Hello {customer_name}", eng(snip(";c", "Hello {customer_name}")).matchSuffix(";c")!!.replacement)
    }

    @Test fun v11_multilineUnicodeVerbatim() {
        val s = "Línea 1\n日本語 ✨\nالعربية"
        assertEquals(s, eng(snip(";u", s)).matchSuffix(";u")!!.replacement)
    }

    @Test fun v12_suggestionsShortestThenLexicographic() {
        val (_, items) = eng(snip(";signature", "x"), snip(";sig", "y"), snip(";sign", "z")).suggestionsFrom(";SI")
        assertEquals(listOf(";sig", ";sign", ";signature"), items.map { it.trigger })
    }

    @Test fun v13_disabledAndDeletedNeverFire() {
        assertNull(eng(snip(";off", "NO", enabled = false)).matchSuffix(";off"))
        assertNull(eng(snip(";del", "NO", deletedAt = 5L)).matchSuffix(";del"))
    }

    // Unicode / emoji cursor vectors: caretBack must be the grapheme-cluster count.
    @Test fun v14to22_cursorCaretBackIsGraphemeClusters() {
        data class C(val after: String, val expected: Int, val before: String = "x")
        val cases = listOf(
            C("abc", 3),
            C("é", 1),                                         // e + combining acute
            C("café", 4),                                      // café (combining)
            C("😀", 1),                                    // 😀 single emoji
            C("🇺🇸", 1),                        // 🇺🇸 flag (2 cp)
            C("👨‍👩‍👧", 1),// 👨‍👩‍👧 ZWJ (5 cp)
            C("👍🏽", 1),                        // 👍🏽 skin tone (2 cp)
            C("👍🏽ok", 3),                      // 👍🏽ok (3 graphemes)
            C("y", 1, "café"),                                 // unicode before marker
        )
        for (c in cases) {
            val a = eng(snip(";c", c.before + "\$|" + c.after)).matchSuffix(";c")!!
            assertEquals("text for ${c.after}", c.before + c.after, a.replacement)
            assertEquals("caretBack for ${c.after}", c.expected, a.caretBack)
        }
    }
}
