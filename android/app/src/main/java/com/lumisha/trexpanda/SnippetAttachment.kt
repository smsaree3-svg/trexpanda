package com.lumisha.trexpanda

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/**
 * A snippet's optional image or file, in the same shape the desktop app stores
 * and syncs (Supabase `snippets.attachment` jsonb): {type, name, mime, data}
 * where data is base64 without a data-URL prefix and type is "image" or "file".
 */
data class SnippetAttachment(
    val type: String,
    val name: String,
    val mime: String,
    val data: String,
) {
    val isImage: Boolean get() = type == "image"

    fun bytes(): ByteArray = java.util.Base64.getMimeDecoder().decode(data)

    /** The stored MIME type, or a sensible guess from the file name. */
    fun effectiveMime(): String {
        if (mime.isNotBlank() && mime.contains('/')) return mime.lowercase()
        val ext = name.substringAfterLast('.', "").lowercase()
        val guess = if (ext.isEmpty()) null else MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
        return guess ?: if (isImage) "image/png" else "application/octet-stream"
    }

    fun toJson(): String = JSONObject().apply {
        put("type", type)
        put("name", name)
        put("mime", mime)
        put("data", data)
    }.toString()

    companion object {
        /** Same limit as the desktop app: attachments sync inside the snippet row. */
        const val MAX_BYTES = 1024 * 1024

        /** Parse the raw jsonb value; null when absent or not a valid attachment. */
        fun parse(raw: String?): SnippetAttachment? {
            if (raw.isNullOrBlank()) return null
            return try {
                val o = JSONObject(raw)
                val type = o.optString("type")
                val data = o.optString("data")
                if ((type != "image" && type != "file") || data.isEmpty()) return null
                SnippetAttachment(
                    type = type,
                    name = safeFileName(o.optString("name"), if (type == "image") "image.png" else "file"),
                    mime = o.optString("mime"),
                    data = data,
                )
            } catch (_: Exception) {
                null
            }
        }

        fun fromBytes(bytes: ByteArray, name: String, mime: String?): SnippetAttachment {
            val m = mime?.lowercase().orEmpty()
            val image = m.startsWith("image/")
            return SnippetAttachment(
                type = if (image) "image" else "file",
                name = safeFileName(name, if (image) "image.png" else "file"),
                mime = m,
                data = java.util.Base64.getEncoder().encodeToString(bytes),
            )
        }

        /**
         * A bare, safe file name (mirrors desktop `safeFileName`): names can come
         * from another device or a shared library, so never trust path parts.
         */
        fun safeFileName(name: String?, fallback: String = "attachment"): String {
            val base = (name ?: "").replace('\\', '/').substringAfterLast('/')
            val cleaned = base.replace(Regex("[\\u0000-\\u001f<>:\"|?*]"), "_").trim().trimStart('.')
            val out = cleaned.take(120)
            return if (out.isBlank()) fallback else out
        }
    }
}

/** Turns an attachment into a shareable content:// file and hands it to other apps. */
object AttachmentFiles {

    private fun authority(context: Context) = context.packageName + ".attachments"

    /** Write (once) to the app cache and return a content URI other apps can read. */
    fun uriFor(context: Context, att: SnippetAttachment, asPng: Boolean = false): Uri {
        val key = Integer.toHexString(att.data.hashCode()) + att.data.length.toString(16) + if (asPng) "p" else ""
        val dir = File(File(context.cacheDir, "attachments"), key)
        val name = if (asPng) att.name.substringBeforeLast('.') + ".png" else att.name
        val file = File(dir, name)
        if (!file.exists() || file.length() == 0L) {
            dir.mkdirs()
            val bytes = att.bytes()
            val tmp = File(dir, "$name.tmp")
            if (asPng) {
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    ?: throw IllegalStateException("Not an image")
                tmp.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            } else {
                tmp.writeBytes(bytes)
            }
            if (!tmp.renameTo(file)) { tmp.copyTo(file, overwrite = true); tmp.delete() }
        }
        return FileProvider.getUriForFile(context, authority(context), file)
    }

    /**
     * Send a FILE (PDF, Excel, ...) to the app being typed in. Chat apps like
     * WhatsApp only take images from a keyboard or paste; documents must come in
     * through Android's share flow, so open that app's "send to" screen with the
     * file attached (the user taps the chat, then Send). Falls back to the system
     * share sheet when that app can't receive files. Returns false if nothing can.
     */
    fun shareToApp(context: Context, att: SnippetAttachment, uri: Uri, targetPackage: String?): Boolean {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = att.effectiveMime()
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri(att.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val pm = context.packageManager
        val direct = if (!targetPackage.isNullOrEmpty() && targetPackage != context.packageName)
            Intent(send).setPackage(targetPackage) else null
        val intent = when {
            direct != null && direct.resolveActivity(pm) != null -> direct
            else -> Intent.createChooser(send, att.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try { context.startActivity(intent); true } catch (_: Exception) { false }
    }

    /**
     * Put the attachment on the clipboard. The clip carries the file URI plus an
     * EMPTY text, so apps that accept images/files paste the attachment, and
     * plain text fields paste nothing instead of a "content://" address.
     */
    fun copyToClipboard(context: Context, att: SnippetAttachment, uri: Uri) {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val desc = ClipDescription(att.name, arrayOf(att.effectiveMime()))
        cm.setPrimaryClip(ClipData(desc, ClipData.Item("", null, null, uri)))
    }
}
