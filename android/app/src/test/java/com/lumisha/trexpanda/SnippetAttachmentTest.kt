package com.lumisha.trexpanda

import android.content.ClipboardManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SnippetAttachmentTest {

    private val desktopJson =
        """{"type":"file","name":"../../evil/Price list.pdf","mime":"application/pdf","data":"JVBERi0xLjQK"}"""

    @Test
    fun parsesDesktopShapeAndSanitizesName() {
        val att = SnippetAttachment.parse(desktopJson)
        assertNotNull(att)
        assertEquals("file", att!!.type)
        assertEquals("Price list.pdf", att.name)
        assertEquals("application/pdf", att.effectiveMime())
        assertEquals("%PDF-1.4\n", String(att.bytes()))
    }

    @Test
    fun rejectsInvalid() {
        assertNull(SnippetAttachment.parse(null))
        assertNull(SnippetAttachment.parse(""))
        assertNull(SnippetAttachment.parse("not json"))
        assertNull(SnippetAttachment.parse("""{"type":"video","data":"AAAA"}"""))
        assertNull(SnippetAttachment.parse("""{"type":"image","data":""}"""))
    }

    @Test
    fun roundTripsThroughJson() {
        val a = SnippetAttachment.fromBytes(byteArrayOf(1, 2, 3), "photo.jpg", "image/jpeg")
        assertEquals("image", a.type)
        assertEquals(a, SnippetAttachment.parse(a.toJson()))
        // And through the Supabase row shape (jsonb object, not a string).
        val s = Snippet(id = "x", trigger = ";p", attachment = a.toJson())
        val row = SnippetJson.snippetToRow(s, "u")
        assertTrue(row.get("attachment") is org.json.JSONObject)
        assertEquals(a, SnippetAttachment.parse(SnippetJson.snippetFromRow(row).attachment))
    }

    @Test
    fun guessesMimeWhenMissing() {
        assertEquals("image/png", SnippetAttachment("image", "x", "", "AA==").effectiveMime())
        assertEquals("application/octet-stream", SnippetAttachment("file", "x", "", "AA==").effectiveMime())
    }

    @Test
    fun engineCarriesAttachmentToExpansion() {
        val engine = ExpanderEngine(listOf(Snippet(id = "1", trigger = ";pl", replacement = "Here:", attachment = desktopJson)))
        assertEquals(desktopJson, engine.matchSuffix("see ;pl")?.attachment)
        assertEquals(desktopJson, engine.snippetAction(";pl")?.attachment)
        assertEquals(desktopJson, AnyKeyboardExpander.expand(engine, "see ;pl", 7)?.attachment)
        assertEquals(desktopJson, AnyKeyboardExpander.applySuggestion(engine, "see ;p", 6, ";pl")?.attachment)
    }

    @Test
    fun writesShareableFileAndClipboard() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val att = SnippetAttachment.parse(desktopJson)!!
        val uri = AttachmentFiles.uriFor(ctx, att)
        assertEquals("content", uri.scheme)
        assertEquals(ctx.packageName + ".attachments", uri.authority)
        AttachmentFiles.copyToClipboard(ctx, att, uri)
        val clip = (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip!!
        assertEquals(uri, clip.getItemAt(0).uri)
        assertEquals("", clip.getItemAt(0).text.toString())
        assertTrue(clip.description.hasMimeType("application/pdf"))
    }
}
