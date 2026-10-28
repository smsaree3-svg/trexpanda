package com.lumisha.trexpanda

import android.content.ClipDescription
import android.inputmethodservice.InputMethodService
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.Toast
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import androidx.core.view.inputmethod.InputContentInfoCompat

/**
 * The Trexpanda keyboard (IME). Because we own the keyboard, text expansion
 * needs no global hook or accessibility service — we watch what the user types
 * on our own keys, feed it to the [ExpanderEngine], and when a trigger fires we
 * delete it and insert the replacement through the InputConnection.
 *
 * As the user types a partial trigger, matching snippets appear in the keyboard's
 * suggestion strip; tapping one expands it immediately. Snippets come from the
 * offline [SnippetStore], which the app keeps synced (in real time) with Supabase.
 */
class TrexpandaImeService : InputMethodService(), TrexpandaKeyboardView.Listener {

    private lateinit var store: SnippetStore
    private val engine = ExpanderEngine()
    private var keyboard: TrexpandaKeyboardView? = null
    private var currentToken: String = ""

    override fun onCreate() {
        super.onCreate()
        store = SnippetStore(this)
    }

    override fun onCreateInputView(): View {
        val kb = TrexpandaKeyboardView(this, this)
        keyboard = kb
        return kb
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        // Reload snippets when the app or a sync has saved changes since last time.
        reloadIfChanged()
        engine.reset()
        clearSuggestions()
    }

    override fun onUpdateSelection(
        oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int,
        candidatesStart: Int, candidatesEnd: Int,
    ) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
        // Android reports a selection change after every character we commit, so
        // this must NOT forget what was typed. Matching reads the real text before
        // the caret instead; here we only refresh the suggestion strip.
        if (newSelStart != newSelEnd) clearSuggestions() else refreshSuggestions()
    }

    // ---- key events ----------------------------------------------------------

    override fun onText(text: String) {
        val ic = currentInputConnection ?: return
        for (ch in text) {
            ic.commitText(ch.toString(), 1)
            // Stateless: look at the text actually before the caret, so cursor
            // callbacks, autocorrect in the app, or text typed earlier can't
            // desync a private buffer.
            val before = ic.getTextBeforeCursor(engine.maxTriggerLen(), 0) ?: continue
            val action = engine.matchSuffix(before)
            if (action != null) expand(ic, action)
        }
        refreshSuggestions()
    }

    override fun onBackspace() {
        val ic = currentInputConnection ?: return
        val selected = ic.getSelectedText(0)
        // A real DEL key event: removes a whole emoji/grapheme and works in apps
        // that listen for key events.
        if (!selected.isNullOrEmpty()) ic.commitText("", 1) else sendDownUpKeyEvents(KeyEvent.KEYCODE_DEL)
        engine.onBackspace()
        refreshSuggestions()
    }

    override fun onEnter() {
        val ic = currentInputConnection ?: return
        engine.reset()
        clearSuggestions()
        val info = currentInputEditorInfo
        val action = info?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_NONE
        val noEnterAction = ((info?.imeOptions ?: 0) and EditorInfo.IME_FLAG_NO_ENTER_ACTION) != 0
        if (!noEnterAction && action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) {
            ic.performEditorAction(action)
        } else {
            // A real Enter key: multi-line fields insert a newline, single-line
            // fields and web inputs get the Enter their listeners expect.
            sendDownUpKeyEvents(KeyEvent.KEYCODE_ENTER)
        }
    }

    override fun onSuggestion(trigger: String) {
        val ic = currentInputConnection ?: return
        val action = engine.snippetAction(trigger) ?: return
        ic.beginBatchEdit()
        try {
            if (currentToken.isNotEmpty()) ic.deleteSurroundingText(currentToken.length, 0)
            ic.commitText(action.replacement, 1)
            moveCaretBack(ic, action.caretBack)
        } finally {
            ic.endBatchEdit()
        }
        UsageStats.recordTrigger(this, action.trigger, currentToken.length, action.replacement.length)
        engine.reset()
        clearSuggestions()
        deliverAttachment(action.attachment)
    }

    // ---- helpers -------------------------------------------------------------

    private var snippetsStamp = -1L

    private fun reloadIfChanged() {
        val stamp = java.io.File(filesDir, "snippets.json").lastModified()
        if (stamp == snippetsStamp) return
        snippetsStamp = stamp
        store = SnippetStore(this)
        engine.setSnippets(store.getPersonal())
    }

    private fun expand(ic: InputConnection, action: ExpanderEngine.Action) {
        ic.beginBatchEdit()
        try {
            if (action.backspaces > 0) ic.deleteSurroundingText(action.backspaces, 0)
            ic.commitText(action.replacement, 1)
            moveCaretBack(ic, action.caretBack)
        } finally {
            ic.endBatchEdit()
        }
        UsageStats.recordTrigger(this, action.trigger, action.backspaces, action.replacement.length)
        engine.reset()
        clearSuggestions()
        deliverAttachment(action.attachment)
    }

    /**
     * Send the snippet's image/file after its text. Apps that accept rich content
     * from keyboards (chat apps, Gmail, Messages...) receive it directly; anywhere
     * else it goes on the clipboard so a long-press -> Paste attaches it.
     */
    private fun deliverAttachment(raw: String?) {
        val att = SnippetAttachment.parse(raw) ?: return
        try {
            val ic = currentInputConnection
            val info = currentInputEditorInfo
            val mime = att.effectiveMime()
            val accepted = info?.let { EditorInfoCompat.getContentMimeTypes(it) }.orEmpty()
            fun accepts(m: String) = accepted.any { ClipDescription.compareMimeTypes(m, it) }
            if (ic != null && info != null) {
                // Many chat boxes accept PNG/GIF/WebP but not JPEG; send those as PNG.
                val asPng = !accepts(mime) && att.isImage && accepts("image/png")
                if (accepts(mime) || asPng) {
                    val uri = AttachmentFiles.uriFor(this, att, asPng)
                    val content = InputContentInfoCompat(
                        uri, ClipDescription(att.name, arrayOf(if (asPng) "image/png" else mime)), null)
                    val ok = InputConnectionCompat.commitContent(
                        ic, info, content, InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION, null)
                    if (ok) return
                }
            }
            AttachmentFiles.copyToClipboard(this, att, AttachmentFiles.uriFor(this, att))
            Toast.makeText(this, getString(R.string.attachment_copied, att.name), Toast.LENGTH_LONG).show()
        } catch (_: Exception) {
            Toast.makeText(this, getString(R.string.attachment_failed), Toast.LENGTH_SHORT).show()
        }
    }

    private fun moveCaretBack(ic: InputConnection, steps: Int) {
        repeat(steps) {
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT))
        }
    }

    private fun refreshSuggestions() {
        val before = currentInputConnection?.getTextBeforeCursor(64, 0) ?: ""
        val (token, items) = engine.suggestionsFrom(before)
        currentToken = token
        keyboard?.setSuggestions(items)
    }

    private fun clearSuggestions() {
        currentToken = ""
        keyboard?.setSuggestions(emptyList())
    }
}
