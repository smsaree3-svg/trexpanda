package com.lumisha.trexpanda

import android.inputmethodservice.InputMethodService
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection

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
        // Reload snippets each time the keyboard appears so edits (and synced
        // changes pushed from other devices) take effect.
        engine.setSnippets(store.getPersonal())
        engine.reset()
        clearSuggestions()
    }

    override fun onUpdateSelection(
        oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int,
        candidatesStart: Int, candidatesEnd: Int,
    ) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
        engine.reset()
        clearSuggestions()
    }

    // ---- key events ----------------------------------------------------------

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
        refreshSuggestions()
    }

    override fun onBackspace() {
        val ic = currentInputConnection ?: return
        val selected = ic.getSelectedText(0)
        if (!selected.isNullOrEmpty()) ic.commitText("", 1) else ic.deleteSurroundingText(1, 0)
        engine.onBackspace()
        refreshSuggestions()
    }

    override fun onEnter() {
        val ic = currentInputConnection ?: return
        engine.reset()
        clearSuggestions()
        val info = currentInputEditorInfo
        val action = info?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_NONE
        val multiline = ((info?.inputType ?: 0) and android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0
        if (!multiline && action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) {
            ic.performEditorAction(action)
        } else {
            ic.commitText("\n", 1)
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
        engine.reset()
        clearSuggestions()
    }

    // ---- helpers -------------------------------------------------------------

    private fun expand(ic: InputConnection, action: ExpanderEngine.Action) {
        ic.beginBatchEdit()
        try {
            if (action.backspaces > 0) ic.deleteSurroundingText(action.backspaces, 0)
            ic.commitText(action.replacement, 1)
            moveCaretBack(ic, action.caretBack)
        } finally {
            ic.endBatchEdit()
        }
        engine.reset()
        clearSuggestions()
    }

    private fun moveCaretBack(ic: InputConnection, steps: Int) {
        repeat(steps) {
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT))
        }
    }

    private fun refreshSuggestions() {
        val (token, items) = engine.suggestions()
        currentToken = token
        keyboard?.setSuggestions(items)
    }

    private fun clearSuggestions() {
        currentToken = ""
        keyboard?.setSuggestions(emptyList())
    }
}
