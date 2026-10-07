package com.lumisha.trexpanda

import android.inputmethodservice.InputMethodService
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection

/**
 * The Trexpanda keyboard (IME). Because we own the keyboard, text expansion
 * needs no global hook or accessibility service — we simply watch what the user
 * types on our own keys, feed it to the [ExpanderEngine], and when a trigger
 * fires we delete it and insert the replacement through the InputConnection.
 *
 * Snippets come from the offline [SnippetStore], which [MainActivity] keeps in
 * sync with Supabase, so a snippet created on the desktop (or on this phone) is
 * available to the keyboard everywhere.
 */
class TrexpandaImeService : InputMethodService(), TrexpandaKeyboardView.Listener {

    private lateinit var store: SnippetStore
    private val engine = ExpanderEngine()

    override fun onCreate() {
        super.onCreate()
        store = SnippetStore(this)
    }

    override fun onCreateInputView(): View {
        return TrexpandaKeyboardView(this, this)
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        // Reload snippets each time the keyboard appears so edits take effect.
        engine.setSnippets(store.getPersonal())
        engine.reset()
    }

    override fun onUpdateSelection(
        oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int,
        candidatesStart: Int, candidatesEnd: Int,
    ) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
        // The caret moved by something other than our own typing: resync the buffer.
        engine.reset()
    }

    // ---- key events from the keyboard view ----------------------------------

    override fun onText(text: String) {
        val ic = currentInputConnection ?: return
        ic.beginBatchEdit()
        try {
            for (ch in text) {
                ic.commitText(ch.toString(), 1)
                val action = engine.onChar(ch)
                if (action != null) expand(ic, action)
            }
        } finally {
            ic.endBatchEdit()
        }
    }

    override fun onBackspace() {
        val ic = currentInputConnection ?: return
        val selected = ic.getSelectedText(0)
        if (!selected.isNullOrEmpty()) {
            ic.commitText("", 1)
        } else {
            ic.deleteSurroundingText(1, 0)
        }
        engine.onBackspace()
    }

    override fun onEnter() {
        val ic = currentInputConnection ?: return
        engine.reset()
        val info = currentInputEditorInfo
        val action = info?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_NONE
        val multiline = (info?.inputType ?: 0) and
            android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0
        if (!multiline && action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) {
            ic.performEditorAction(action)
        } else {
            ic.commitText("\n", 1)
        }
    }

    /** Delete the typed trigger and insert the replacement, then place the caret. */
    private fun expand(ic: InputConnection, action: ExpanderEngine.Action) {
        ic.beginBatchEdit()
        try {
            if (action.backspaces > 0) ic.deleteSurroundingText(action.backspaces, 0)
            ic.commitText(action.replacement, 1)
            // Move the caret back by caretBack code points (one Left per step).
            repeat(action.caretBack) {
                ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
                ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT))
            }
        } finally {
            ic.endBatchEdit()
        }
        // The replacement text is already committed; start matching fresh after it.
        engine.reset()
    }
}
