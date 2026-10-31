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

    private val usageIo = java.util.concurrent.Executors.newSingleThreadExecutor()

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
                AccessibilityEvent.TYPE_WINDOWS_CHANGED -> if (!keyboardVisible()) hideStrip() else repositionStrip()
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
                if (edit != null) { if (apply(node, edit)) recordUse(edit, text); hideStrip(); return }
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

    /** Count the expansion: characters added beyond what was typed are the ones saved. */
    private fun recordUse(edit: AnyKeyboardExpander.Edit, before: String) {
        val typed = edit.trigger.length
        val added = (edit.text.length - before.length).coerceAtLeast(0)
        // This service runs in its own process; usage is kept in the main
        // process's SharedPreferences, which can't be written safely from here.
        val ctx = applicationContext
        try {
            usageIo.execute {
                try { UsageProvider.record(ctx, edit.trigger, typed, typed + added) } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
    }

    private fun apply(node: AccessibilityNodeInfo, edit: AnyKeyboardExpander.Edit): Boolean {
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
            return true
        }
        return false
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
            val uri = AttachmentFiles.uriFor(this, att)
            AttachmentFiles.copyToClipboard(this, att, uri)
            // Documents can't be pasted into chat apps: open that app's send screen with the file.
            if (!att.isImage && AttachmentFiles.shareToApp(this, att, uri, node.packageName?.toString())) {
                Toast.makeText(this, getString(R.string.attachment_share, att.name), Toast.LENGTH_LONG).show()
                return
            }
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
                AnyKeyboardExpander.applySuggestion(engine, text, caret, trigger)?.let { if (apply(node, it)) recordUse(it, text) }
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
            setPadding(dp(8), dp(4), dp(8), dp(4))
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
                setPadding(dp(12), dp(6), dp(12), dp(6))
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
        val lp = stripLayout(sv) ?: run { hideStrip(); return }
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        if (stripShown) wm.updateViewLayout(sv, lp) else { wm.addView(sv, lp); stripShown = true }
    }

    /** Keep the strip glued to the keyboard's top edge when the keyboard moves or resizes. */
    private fun repositionStrip() {
        val sv = strip ?: return
        if (!stripShown) return
        val lp = stripLayout(sv) ?: run { hideStrip(); return }
        try { (getSystemService(WINDOW_SERVICE) as WindowManager).updateViewLayout(sv, lp) } catch (_: Exception) {}
    }

    /**
     * Place the strip over the keyboard's own top bar (its word-suggestion /
     * toolbar row), in absolute screen coordinates: the letters and the text box
     * being typed in both stay visible. (Measuring from the bottom of the screen
     * was off by the navigation-bar height on phones with on-screen nav buttons,
     * which put the strip over the keyboard's top row of letters.)
     */
    private fun stripLayout(sv: View): WindowManager.LayoutParams? {
        val kbTop = keyboardTop() ?: return null
        val screenW = resources.displayMetrics.widthPixels
        sv.measure(
            View.MeasureSpec.makeMeasureSpec(screenW, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
        )
        val h = sv.measuredHeight.takeIf { it > 0 } ?: dp(44)
        return WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            h,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = kbTop.coerceAtLeast(0)
            if (android.os.Build.VERSION.SDK_INT >= 30) setFitInsetsTypes(0)
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
    }

    private fun hideStrip() {
        val sv = strip ?: return
        if (!stripShown) return
        try { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(sv) } catch (_: Exception) {}
        stripShown = false
    }

    /** Top edge of the on-screen keyboard in screen pixels, or null when it's hidden. */
    private fun keyboardTop(): Int? {
        val ime = windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } ?: return null
        val r = Rect()
        ime.getBoundsInScreen(r)
        return if (r.height() > 0) r.top else null
    }

    private fun keyboardVisible(): Boolean =
        windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }

    override fun onInterrupt() { hideStrip() }

    override fun onDestroy() { hideStrip(); usageIo.shutdown(); super.onDestroy() }

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
