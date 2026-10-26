package com.lumisha.trexpanda

import android.accessibilityservice.AccessibilityService
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.io.File

/**
 * Optional "any-keyboard mode": expands snippet triggers typed with ANY keyboard
 * (Gboard, Samsung, SwiftKey...), and shows a small strip of matching snippets
 * just above that keyboard while a trigger is being typed.
 *
 * Only acts on editable, non-password fields; when the text before the caret
 * ends with one of the user's triggers, it replaces the trigger in that field.
 * It never stores, logs or sends what is typed. Users turn it on themselves in
 * Accessibility settings after an in-app explanation.
 */
class TrexpandaAccessibilityService : AccessibilityService() {

    private val engine = ExpanderEngine()
    private var snippetsStamp = -1L
    private var lastEditAt = 0L

    private var strip: HorizontalScrollView? = null
    private var chips: LinearLayout? = null
    private var stripShown = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        SupabaseConfig.load(this)
        reloadIfChanged()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        try {
            when (event.eventType) {
                AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
                AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED -> onTyping(event)
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
                AccessibilityEvent.TYPE_WINDOWS_CHANGED -> if (!keyboardVisible()) hideStrip()
            }
        } catch (_: Exception) {
            // Never crash someone else's text field.
            hideStrip()
        }
    }

    private fun onTyping(event: AccessibilityEvent) {
        if (event.packageName == packageName || trexpandaKeyboardActive()) { hideStrip(); return }
        val node = event.source ?: return
        try {
            if (!node.isEditable || node.isPassword) { hideStrip(); return }
            reloadIfChanged()
            val text = node.text?.toString() ?: run { hideStrip(); return }
            val caret = node.textSelectionEnd.takeIf { it >= 0 } ?: text.length

            // 1. Expand a finished trigger (typing only, not deletions, and not the
            //    text change our own replacement just caused).
            val typed = event.eventType == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED && event.addedCount > 0
            if (typed && System.currentTimeMillis() - lastEditAt >= 150) {
                val edit = AnyKeyboardExpander.expand(engine, text, caret)
                if (edit != null) { apply(node, edit); hideStrip(); return }
            }

            // 2. Otherwise suggest snippets for the trigger being typed.
            val token = AnyKeyboardExpander.currentToken(text, caret)
            if (!AnyKeyboardExpander.shouldSuggest(token)) { hideStrip(); return }
            val (_, items) = engine.suggestionsFrom(text.substring(0, caret), limit = 6)
            if (items.isEmpty()) hideStrip() else showStrip(items)
        } finally {
            @Suppress("DEPRECATION")
            node.recycle()
        }
    }

    private fun apply(node: AccessibilityNodeInfo, edit: AnyKeyboardExpander.Edit) {
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
            pasteAttachment(node, edit.attachment)
        }
    }

    /**
     * Deliver the snippet's image/file after its text: put it on the clipboard
     * and paste it into the same field. Apps that take pasted images/files
     * (WhatsApp, Gmail, Messages...) attach it; plain text boxes paste nothing,
     * and it stays on the clipboard for a manual long-press -> Paste.
     */
    private fun pasteAttachment(node: AccessibilityNodeInfo, raw: String?) {
        val att = SnippetAttachment.parse(raw) ?: return
        try {
            AttachmentFiles.copyToClipboard(this, att, AttachmentFiles.uriFor(this, att))
            lastEditAt = System.currentTimeMillis()
            node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            Toast.makeText(this, getString(R.string.attachment_copied, att.name), Toast.LENGTH_LONG).show()
        } catch (_: Exception) {
            Toast.makeText(this, getString(R.string.attachment_failed), Toast.LENGTH_SHORT).show()
        }
    }

    /** A suggestion was tapped: insert that snippet in the field being typed in. */
    private fun useSuggestion(trigger: String) {
        try {
            val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
            try {
                if (!node.isEditable || node.isPassword) return
                val text = node.text?.toString() ?: ""
                val caret = node.textSelectionEnd.takeIf { it >= 0 } ?: text.length
                AnyKeyboardExpander.applySuggestion(engine, text, caret, trigger)?.let { apply(node, it) }
            } finally {
                @Suppress("DEPRECATION")
                node.recycle()
            }
        } catch (_: Exception) {
        } finally {
            hideStrip()
        }
    }

    // ---- suggestion strip (an accessibility overlay above the keyboard) -------

    private fun dp(v: Int) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun ensureStrip(): HorizontalScrollView {
        strip?.let { return it }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(8), dp(6), dp(8), dp(6))
        }
        val sv = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            background = GradientDrawable().apply { setColor(Color.parseColor("#F2121E44")) }
            addView(row)
        }
        chips = row
        strip = sv
        return sv
    }

    private fun showStrip(items: List<ExpanderEngine.Suggestion>) {
        val sv = ensureStrip()
        val row = chips ?: return
        row.removeAllViews()
        for (item in items) {
            val chip = TextView(this).apply {
                text = item.trigger + "  " + (if (item.hasAttachment) "📎 " else "") + item.preview
                maxWidth = dp(260)
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                setPadding(dp(12), dp(8), dp(12), dp(8))
                background = GradientDrawable().apply {
                    cornerRadius = dp(16).toFloat()
                    setColor(Color.parseColor("#2F6BFF"))
                }
                contentDescription = "Insert snippet ${item.trigger}"
                setOnClickListener { useSuggestion(item.trigger) }
            }
            row.addView(chip, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = dp(6) })
        }
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.START
            y = keyboardHeight()
        }
        if (stripShown) wm.updateViewLayout(sv, lp) else { wm.addView(sv, lp); stripShown = true }
    }

    private fun hideStrip() {
        val sv = strip ?: return
        if (!stripShown) return
        try { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(sv) } catch (_: Exception) {}
        stripShown = false
    }

    /** Height of the on-screen keyboard from the bottom of the screen (0 if hidden). */
    private fun keyboardHeight(): Int {
        val ime = windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } ?: return 0
        val r = Rect()
        ime.getBoundsInScreen(r)
        return (resources.displayMetrics.heightPixels - r.top).coerceAtLeast(0)
    }

    private fun keyboardVisible(): Boolean =
        windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }

    override fun onInterrupt() { hideStrip() }

    override fun onDestroy() { hideStrip(); super.onDestroy() }

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
