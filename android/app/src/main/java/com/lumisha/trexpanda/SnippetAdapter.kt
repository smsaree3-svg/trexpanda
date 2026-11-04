package com.lumisha.trexpanda

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.widget.PopupMenu
import androidx.recyclerview.widget.RecyclerView

/**
 * RecyclerView adapter for the snippet list in [MainActivity].
 *
 * Tap a row to edit it; long-press it (or tap ⋮) for Edit / Copy text / Delete.
 */
class SnippetAdapter(
    private val onEdit: (Snippet) -> Unit,
    private val onDelete: (Snippet) -> Unit,
    private val onCopy: (Snippet) -> Unit = {},
) : RecyclerView.Adapter<SnippetAdapter.VH>() {

    private val items = mutableListOf<Snippet>()
    private var usage: org.json.JSONObject = org.json.JSONObject()

    fun submit(list: List<Snippet>, usageStats: org.json.JSONObject? = null) {
        if (usageStats != null) usage = usageStats
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_snippet, parent, false)
        return VH(v)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: VH, position: Int) = holder.bind(items[position])

    inner class VH(view: View) : RecyclerView.ViewHolder(view) {
        private val content: View = view.findViewById(R.id.itemContent)
        private val trigger: TextView = view.findViewById(R.id.itemTrigger)
        private val uses: TextView = view.findViewById(R.id.itemUses)
        private val disabled: TextView = view.findViewById(R.id.itemDisabled)
        private val name: TextView = view.findViewById(R.id.itemName)
        private val preview: TextView = view.findViewById(R.id.itemPreview)
        private val attachment: TextView = view.findViewById(R.id.itemAttachment)
        private val more: ImageButton = view.findViewById(R.id.itemMore)

        fun bind(s: Snippet) {
            val trig = s.trigger.orEmpty()
            trigger.text = trig

            val count = UsageStats.countFor(usage, s)
            uses.visibility = if (count > 0) View.VISIBLE else View.GONE
            uses.text = "used $count×"

            disabled.visibility = if (s.enabled) View.GONE else View.VISIBLE

            // Only show a name the user actually gave it (not a copy of the trigger).
            val label = s.label?.trim().orEmpty()
            val hasName = label.isNotEmpty() && !label.equals(trig, ignoreCase = true)
            name.visibility = if (hasName) View.VISIBLE else View.GONE
            name.text = label

            val raw = s.replacement.replace(Regex("\\s+"), " ").trim()
            val att = SnippetAttachment.parse(s.attachment)
            preview.visibility = if (raw.isEmpty() && att != null) View.GONE else View.VISIBLE
            preview.text = raw.ifEmpty { "(no text)" }

            attachment.visibility = if (att != null) View.VISIBLE else View.GONE
            attachment.text = att?.name.orEmpty()

            content.alpha = if (s.enabled) 1f else 0.55f

            itemView.contentDescription = buildString {
                append("Snippet ").append(trig)
                if (hasName) append(", ").append(label)
                if (!s.enabled) append(", turned off")
                if (count > 0) append(", used ").append(count).append(" times")
                if (att != null) append(", with attachment ").append(att.name)
                append(". ").append(raw.take(120))
            }

            itemView.setOnClickListener { onEdit(s) }
            itemView.setOnLongClickListener { showMenu(it, s); true }
            more.contentDescription = "More options for $trig"
            more.setOnClickListener { showMenu(it, s) }
        }

        private fun showMenu(anchor: View, s: Snippet) {
            val popup = PopupMenu(anchor.context, anchor)
            popup.menuInflater.inflate(R.menu.menu_snippet, popup.menu)
            popup.setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    R.id.action_edit -> { onEdit(s); true }
                    R.id.action_copy -> { onCopy(s); true }
                    R.id.action_delete -> { onDelete(s); true }
                    else -> false
                }
            }
            popup.show()
        }
    }
}
