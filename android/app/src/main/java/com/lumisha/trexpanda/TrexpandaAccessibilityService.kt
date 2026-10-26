package com.lumisha.trexpanda

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.File

/**
 * Optional "any-keyboard mode": expands snippet triggers typed with ANY keyboard
 * (Gboard, Samsung, SwiftKey...). Only acts on text-change events in editable,
 * non-password fields; when the text before the caret ends with one of the
 * user's triggers, it replaces the trigger in that field. It never stores,
 * logs or sends what is typed. Users turn it on themselves in Accessibility
 * settings after an in-app explanation.
 */
class TrexpandaAccessibilityService : AccessibilityService() {

    private val engine = ExpanderEngine()
    private var snippetsStamp = -1L
    private var lastEditAt = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        SupabaseConfig.load(this)
        reloadIfChanged()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || event.eventType != AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) return
        if (event.packageName == packageName) return // our own app/keyboard handles itself
        if (event.addedCount <= 0) return             // only react to typing, not deletions
        if (trexpandaKeyboardActive()) return         // our own keyboard already expands
        val node = event.source ?: return
        try {
            if (!node.isEditable || node.isPassword) return
            // Ignore the text change our own replacement just caused.
            if (System.currentTimeMillis() - lastEditAt < 150) return
            reloadIfChanged()
            val text = node.text?.toString() ?: return
            val caret = node.textSelectionEnd.takeIf { it >= 0 } ?: text.length
            val edit = AnyKeyboardExpander.expand(engine, text, caret) ?: return
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, edit.text)
            }
            lastEditAt = System.currentTimeMillis()
            if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                val sel = Bundle().apply {
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, edit.caret)
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, edit.caret)
                }
                node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
            }
        } catch (_: Exception) {
            // Never crash someone else's text field.
        } finally {
            @Suppress("DEPRECATION")
            node.recycle()
        }
    }

    override fun onInterrupt() {}

    /** True when the Trexpanda keyboard is the current input method (it expands itself). */
    private fun trexpandaKeyboardActive(): Boolean {
        val current = android.provider.Settings.Secure.getString(
            contentResolver, android.provider.Settings.Secure.DEFAULT_INPUT_METHOD
        ) ?: return false
        return current.startsWith("$packageName/")
    }

    /** Reload snippets when the app (or sync) has saved changes. */
    private fun reloadIfChanged() {
        val stamp = File(filesDir, "snippets.json").lastModified()
        if (stamp == snippetsStamp) return
        snippetsStamp = stamp
        engine.setSnippets(SnippetStore(this).getPersonal())
    }
}
