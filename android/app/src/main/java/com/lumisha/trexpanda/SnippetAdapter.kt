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

    fun submit(list: List<Snippet>) {
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
            trigger.text = s.trigger ?: ""
            val raw = s.replacement.replace(Regex("\\s+"), " ").trim()
            preview.text = if (s.enabled) raw else "$raw  (disabled)"
            preview.alpha = if (s.enabled) 1f else 0.5f
            itemView.setOnClickListener { onEdit(s) }
            delete.setOnClickListener { onDelete(s) }
        }
    }
}
