package com.lumisha.trexpanda

import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowLooper
import java.io.File

/**
 * Renders real app screens for the Google Play listing. Skipped unless
 * TREX_STORE_SHOTS names an output folder (the store-screenshots workflow sets it).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w360dp-h640dp-xxhdpi")
class StoreScreenshots {

    private val outDir: File? = System.getenv("TREX_STORE_SHOTS")?.let { File(it) }

    private val samples = listOf(
        Snippet("00000000-0000-4000-8000-000000000001", ";addr", "221 Market Street, Suite 400, San Francisco, CA 94105", "Office address"),
        Snippet("00000000-0000-4000-8000-000000000002", ";email", "hello@yourcompany.com", "Work email"),
        Snippet("00000000-0000-4000-8000-000000000003", ";ty", "Thank you so much! Let me know if there's anything else I can help with.", "Thank you"),
        Snippet("00000000-0000-4000-8000-000000000004", ";meet", "Here's my meeting link: https://meet.example.com/you", "Meeting link"),
        Snippet("00000000-0000-4000-8000-000000000005", ";sig", "Best regards,\nAlex Morgan\nCustomer Success", "Signature"),
        Snippet("00000000-0000-4000-8000-000000000006", ";date", "{date}", "Today's date"),
        Snippet("00000000-0000-4000-8000-000000000007", ";price", "Here's our latest price list:", "Price list",
            attachment = SnippetAttachment.fromBytes(ByteArray(64), "Price list.pdf", "application/pdf").toJson()),
        Snippet("00000000-0000-4000-8000-000000000008", ";track", "You can track your order here: https://track.example.com", "Order tracking"),
    )

    private fun ctx(): Context = ApplicationProvider.getApplicationContext()

    private fun save(bmp: Bitmap, name: String) {
        val dir = outDir ?: return
        dir.mkdirs()
        File(dir, name).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun render(view: View, w: Int, h: Int): Bitmap {
        view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, w, h)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bmp))
        return bmp
    }

    private fun screen(): Pair<Int, Int> = ctx().resources.displayMetrics.let { it.widthPixels to it.heightPixels }

    @Test
    fun snippetList() {
        assumeTrue(outDir != null)
        SnippetStore(ctx()).setPersonal(samples)
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        ShadowLooper.idleMainLooper()
        val (w, h) = screen()
        // Scroll so the snippet list is in view below the setup buttons.
        val recycler = activity.findViewById<RecyclerView>(R.id.recycler)
        val scroll = activity.findViewById<View>(R.id.scroll)
        render(activity.window.decorView, w, h)
        scroll.scrollTo(0, (recycler.top - (160 * activity.resources.displayMetrics.density).toInt()).coerceAtLeast(0))
        save(render(activity.window.decorView, w, h), "2-snippets.png")
        scroll.scrollTo(0, 0)
        save(render(activity.window.decorView, w, h), "1-home.png")
    }

    @Test
    fun editorWithAttachment() {
        assumeTrue(outDir != null)
        SnippetStore(ctx()).setPersonal(samples)
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val (w, h) = screen()
        val recycler = activity.findViewById<RecyclerView>(R.id.recycler)
        render(activity.window.decorView, w, h)
        // Open the ";price" snippet (it has a PDF attachment).
        val idx = samples.sortedBy { it.trigger }.indexOfFirst { it.trigger == ";price" }
        recycler.scrollToPosition(idx)
        render(activity.window.decorView, w, h)
        val holder = recycler.findViewHolderForAdapterPosition(idx) ?: return
        holder.itemView.performClick()
        ShadowLooper.idleMainLooper()
        val dialog: Dialog = ShadowDialog.getLatestDialog() ?: return
        val bg = render(activity.window.decorView, w, h)
        val canvas = Canvas(bg)
        canvas.drawColor(Color.argb(150, 0, 0, 0))
        val dv = dialog.window!!.decorView
        val dw = (w * 0.9).toInt()
        dv.measure(View.MeasureSpec.makeMeasureSpec(dw, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.AT_MOST))
        dv.layout(0, 0, dw, dv.measuredHeight)
        canvas.save()
        canvas.translate(((w - dw) / 2).toFloat(), ((h - dv.measuredHeight) / 2).toFloat())
        dv.draw(canvas)
        canvas.restore()
        save(bg, "3-editor.png")
    }

    @Test
    fun keyboardSuggestions() {
        assumeTrue(outDir != null)
        val context = ctx()
        context.setTheme(R.style.Theme_Trexpanda)
        val d = context.resources.displayMetrics.density
        val engine = ExpanderEngine(samples)
        val (_, items) = engine.suggestionsFrom("Hi Sam, sure! ;", limit = 6)
        val kb = TrexpandaKeyboardView(context, object : TrexpandaKeyboardView.Listener {
            override fun onText(text: String) {}
            override fun onBackspace() {}
            override fun onEnter() {}
            override fun onSuggestion(trigger: String) {}
        })
        kb.setSuggestions(items)

        val (w, h) = screen()
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#ECE5DD"))
        }
        val chat = FrameLayout(context)
        fun bubble(text: String, mine: Boolean) = TextView(context).apply {
            this.text = text
            textSize = 16f
            setTextColor(Color.parseColor("#111B21"))
            setPadding((12 * d).toInt(), (8 * d).toInt(), (12 * d).toInt(), (8 * d).toInt())
            background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = 12 * d
                setColor(Color.parseColor(if (mine) "#D9FDD3" else "#FFFFFF"))
            }
            maxWidth = (w * 0.75).toInt()
        }
        val col = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setPadding((12 * d).toInt(), (16 * d).toInt(), (12 * d).toInt(), 0) }
        col.addView(bubble("Hi! Can you send me your office address?", false), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { gravity = Gravity.START; bottomMargin = (10 * d).toInt() })
        col.addView(bubble("Sure! 221 Market Street, Suite 400, San Francisco, CA 94105", true), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { gravity = Gravity.END; bottomMargin = (10 * d).toInt() })
        col.addView(bubble("Perfect, thanks. And the price list?", false), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { gravity = Gravity.START })
        chat.addView(col)
        root.addView(chat, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        val input = TextView(context).apply {
            text = "Here you go ;"
            textSize = 17f
            setTextColor(Color.parseColor("#111B21"))
            setPadding((16 * d).toInt(), (12 * d).toInt(), (16 * d).toInt(), (12 * d).toInt())
            background = android.graphics.drawable.GradientDrawable().apply { cornerRadius = 24 * d; setColor(Color.WHITE) }
        }
        root.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            setMargins((8 * d).toInt(), 0, (8 * d).toInt(), (8 * d).toInt())
        })
        root.addView(kb, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        save(render(root, w, h), "4-keyboard.png")
    }
}
