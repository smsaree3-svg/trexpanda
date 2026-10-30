package com.lumisha.trexpanda

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Bundle

/**
 * Lets any-keyboard mode, which runs in its own `:anykeyboard` process, record
 * snippet use through the main process. [UsageStats] lives in SharedPreferences,
 * which is not safe across processes: each process keeps its own cached copy
 * and rewrites the whole file, so counts recorded in the other process were lost
 * (and could wipe this device's id). Not exported; only this app can call it.
 */
class UsageProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        if (method != METHOD_RECORD || arg.isNullOrEmpty()) return null
        val c = context ?: return null
        UsageStats.recordTrigger(c, arg, extras?.getInt(EXTRA_TYPED) ?: 0, extras?.getInt(EXTRA_OUT) ?: 0)
        return null
    }

    override fun query(
        uri: Uri, projection: Array<out String>?, selection: String?,
        selectionArgs: Array<out String>?, sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    companion object {
        private const val METHOD_RECORD = "record"
        private const val EXTRA_TYPED = "typed"
        private const val EXTRA_OUT = "out"

        fun authority(context: Context) = context.packageName + ".usage"

        /** Record an expansion of [trigger] in the main process (blocking IPC: call off the main thread). */
        fun record(context: Context, trigger: String, typedChars: Int, outChars: Int) {
            val extras = Bundle().apply {
                putInt(EXTRA_TYPED, typedChars)
                putInt(EXTRA_OUT, outChars)
            }
            context.contentResolver.call(Uri.parse("content://" + authority(context)), METHOD_RECORD, trigger, extras)
        }
    }
}
