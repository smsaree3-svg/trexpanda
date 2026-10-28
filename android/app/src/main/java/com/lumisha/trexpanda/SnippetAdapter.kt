package com.lumisha.trexpanda

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView

/** RecyclerView adapter for the snippet list in [MainActivity]. */
class SnippetAdapter(
    private val onEdit: (Snippet) -> Unit,
    private val onDelete: (Snippet) -> Unit,
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
        private val trigger: TextView = view.findViewById(R.id.itemTrigger)
        private val preview: TextView = view.findViewById(R.id.itemPreview)
        private val delete: ImageButton = view.findViewById(R.id.itemDelete)

        fun bind(s: Snippet) {
            val uses = UsageStats.countFor(usage, s)
            trigger.text = if (uses > 0) "${s.trigger}  ·  used ${uses}×" else s.trigger
            val raw = s.replacement.replace(Regex("\\s+"), " ").trim()
            val att = SnippetAttachment.parse(s.attachment)?.let { "📎 ${it.name}  " } ?: ""
            preview.text = if (s.enabled) att + raw else "$att$raw  (disabled)"
            preview.alpha = if (s.enabled) 1f else 0.5f
            itemView.setOnClickListener { onEdit(s) }
            delete.setOnClickListener { onDelete(s) }
        }
    }
}
