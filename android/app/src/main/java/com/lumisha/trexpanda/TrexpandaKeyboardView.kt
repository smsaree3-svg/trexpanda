package com.lumisha.trexpanda

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView

/**
 * A compact, self-contained soft keyboard rendered as rows of key views (no
 * dependency on the deprecated android.inputmethodservice.KeyboardView).
 *
 * It only reports key events to [listener]; the IME service owns all the input
 * logic (committing text, running the expander). Two layers (letters + symbols)
 * and a shift make it a usable everyday keyboard; the expansion magic happens in
 * [TrexpandaImeService], which is the whole point of shipping our own keyboard.
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
    }

    private var shifted = true          // start capitalized, like most keyboards
    private var symbols = false

    private val lettersRows = listOf(
        "qwertyuiop".toCharArray().map { it.toString() },
        "asdfghjkl".toCharArray().map { it.toString() },
        "zxcvbnm".toCharArray().map { it.toString() },
    )
    private val symbolRows = listOf(
        "1234567890".toCharArray().map { it.toString() },
        listOf("@", "#", "$", "%", "&", "*", "-", "+", "(", ")"),
        listOf("!", "\"", "'", ":", ";", "/", "?"),
    )

    init {
        orientation = VERTICAL
        setBackgroundColor(Color.parseColor("#0F1420"))
        val pad = dp(4)
        setPadding(pad, pad, pad, pad)
        rebuild()
    }

    private fun rebuild() {
        removeAllViews()
        val rows = if (symbols) symbolRows else lettersRows
        for (keys in rows) {
            addView(makeRow {
                for (k in keys) {
                    val label = if (!symbols && shifted) k.uppercase() else k
                    addKey(this, label, weight = 1f) {
                        listener.onText(label)
                        if (shifted && !symbols) { shifted = false; rebuild() }
                    }
                }
            })
        }
        // Function row: shift/layer-left, letters/symbols block already above; add controls.
        addView(makeRow {
            val leftLabel = if (symbols) "?123" else if (shifted) "⇧" else "⇧"
            addKey(this, if (symbols) "#+=" else "⇧", weight = 1.5f, accent = true) {
                if (symbols) { /* secondary symbols not implemented; no-op */ }
                else { shifted = !shifted; rebuild() }
            }
            addKey(this, "⌫", weight = 1.5f, accent = true) { listener.onBackspace() }
        })
        addView(makeRow {
            addKey(this, if (symbols) "ABC" else "?123", weight = 1.5f, accent = true) {
                symbols = !symbols; rebuild()
            }
            addKey(this, ",", weight = 1f) { listener.onText(",") }
            addKey(this, "space", weight = 4f) { listener.onText(" ") }
            addKey(this, ".", weight = 1f) { listener.onText(".") }
            addKey(this, "return", weight = 1.5f, accent = true) { listener.onEnter() }
        })
    }

    private inline fun makeRow(block: LinearLayout.() -> Unit): LinearLayout {
        val row = LinearLayout(context)
        row.orientation = HORIZONTAL
        row.layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))
        row.gravity = Gravity.CENTER
        row.block()
        return row
    }

    private fun addKey(row: LinearLayout, label: String, weight: Float, accent: Boolean = false, onClick: () -> Unit) {
        val key = TextView(context)
        key.text = label
        key.gravity = Gravity.CENTER
        key.setTextColor(Color.parseColor("#E6EBF5"))
        key.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (label.length > 2) 14f else 20f)
        key.setBackgroundColor(if (accent) Color.parseColor("#2A3346") else Color.parseColor("#171D2B"))
        val m = dp(2)
        val lp = LayoutParams(0, LayoutParams.MATCH_PARENT, weight)
        lp.setMargins(m, m, m, m)
        key.layoutParams = lp
        key.isClickable = true
        key.setOnClickListener { onClick() }
        row.addView(key)
    }

    private fun dp(v: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()
}
