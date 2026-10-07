package com.lumisha.trexpanda

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The Trexpanda soft keyboard: a clean, self-contained key grid with press
 * ripples, plus a live suggestion strip that surfaces matching snippets as you
 * type a trigger. No dependency on the deprecated KeyboardView.
 *
 * All input logic lives in [TrexpandaImeService]; this view only reports key and
 * suggestion taps to [listener].
 */
@SuppressLint("ViewConstructor")
class TrexpandaKeyboardView(
    context: Context,
    private val listener: Listener,
) : LinearLayout(context) {

    interface Listener {
        fun onText(text: String)
        fun onBackspace()
        fun onEnter()
        fun onSuggestion(trigger: String)
    }

    private var shifted = true
    private var symbols = false

    private lateinit var suggestionStrip: LinearLayout
    private lateinit var keyArea: LinearLayout

    private val lettersRows = listOf(
        "qwertyuiop".map { it.toString() },
        "asdfghjkl".map { it.toString() },
        "zxcvbnm".map { it.toString() },
    )
    private val symbolRows = listOf(
        "1234567890".map { it.toString() },
        listOf("@", "#", "$", "%", "&", "*", "-", "+", "(", ")"),
        listOf("!", "\"", "'", ":", ";", "/", "?"),
    )

    init {
        orientation = VERTICAL
        setBackgroundColor(color(R.color.kbBg))
        val pad = dp(5)
        setPadding(pad, dp(6), pad, dp(8))
        buildSuggestionStrip()
        keyArea = LinearLayout(context).apply { orientation = VERTICAL }
        addView(keyArea)
        rebuildKeys()
    }

    private fun buildSuggestionStrip() {
        val scroll = HorizontalScrollView(context).apply {
            isHorizontalScrollBarEnabled = false
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, dp(46))
        }
        suggestionStrip = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
        }
        scroll.addView(suggestionStrip)
        addView(scroll)
        showHint()
    }

    private fun showHint() {
        suggestionStrip.removeAllViews()
        val hint = TextView(context).apply {
            text = "Trexpanda"
            setTextColor(color(R.color.muted))
            textSize = 13f
            setPadding(dp(10), 0, dp(10), 0)
            gravity = Gravity.CENTER_VERTICAL
        }
        suggestionStrip.addView(hint)
    }

    /** Populate the strip with live suggestions (empty clears it to the hint). */
    fun setSuggestions(items: List<ExpanderEngine.Suggestion>) {
        suggestionStrip.removeAllViews()
        if (items.isEmpty()) { showHint(); return }
        for (s in items) {
            val chip = TextView(context).apply {
                text = s.trigger
                setTextColor(color(R.color.brand))
                textSize = 14f
                typeface = android.graphics.Typeface.MONOSPACE
                gravity = Gravity.CENTER
                setBackgroundResource(R.drawable.suggestion_chip_bg)
                val h = dp(8); val v = dp(7)
                setPadding(dp(14), v, dp(14), v)
                isClickable = true
                setOnClickListener { listener.onSuggestion(s.trigger) }
            }
            val lp = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
            lp.setMargins(dp(4), 0, dp(4), 0)
            chip.layoutParams = lp
            suggestionStrip.addView(chip)
        }
    }

    private fun rebuildKeys() {
        keyArea.removeAllViews()
        val rows = if (symbols) symbolRows else lettersRows
        for (keys in rows) {
            keyArea.addView(makeRow {
                for (k in keys) {
                    val label = if (!symbols && shifted) k.uppercase() else k
                    addKey(this, label, 1f) {
                        listener.onText(label)
                        if (shifted && !symbols) { shifted = false; rebuildKeys() }
                    }
                }
            })
        }
        keyArea.addView(makeRow {
            addKey(this, if (symbols) "#+=" else "⇧", 1.5f, accent = true) {
                if (!symbols) { shifted = !shifted; rebuildKeys() }
            }
            addKey(this, "⌫", 1.5f, accent = true) { listener.onBackspace() }
        })
        keyArea.addView(makeRow {
            addKey(this, if (symbols) "ABC" else "?123", 1.5f, accent = true) {
                symbols = !symbols; rebuildKeys()
            }
            addKey(this, ",", 1f) { listener.onText(",") }
            addKey(this, "space", 4f) { listener.onText(" ") }
            addKey(this, ".", 1f) { listener.onText(".") }
            addKey(this, "return", 1.5f, accent = true) { listener.onEnter() }
        })
    }

    private inline fun makeRow(block: LinearLayout.() -> Unit): LinearLayout {
        val row = LinearLayout(context)
        row.orientation = HORIZONTAL
        row.layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50))
        row.gravity = Gravity.CENTER
        row.block()
        return row
    }

    private fun addKey(row: LinearLayout, label: String, weight: Float, accent: Boolean = false, onClick: () -> Unit) {
        val key = TextView(context)
        key.text = label
        key.gravity = Gravity.CENTER
        key.setTextColor(color(R.color.kbKeyText))
        key.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (label.length > 2) 13.5f else 19f)
        key.setBackgroundResource(if (accent) R.drawable.key_bg_accent else R.drawable.key_bg)
        val m = dp(3)
        val lp = LayoutParams(0, LayoutParams.MATCH_PARENT, weight)
        lp.setMargins(m, m, m, m)
        key.layoutParams = lp
        key.isClickable = true
        key.setOnClickListener { onClick() }
        row.addView(key)
    }

    private fun color(id: Int): Int = resources.getColor(id, null)
    private fun dp(v: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()
}
