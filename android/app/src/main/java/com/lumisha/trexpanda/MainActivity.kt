package com.lumisha.trexpanda

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePadding
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * The companion app: sign in with Google (Supabase), manage personal snippets,
 * sync them across devices, and enable/switch to the Trexpanda keyboard.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var auth: AuthManager
    private lateinit var store: SnippetStore
    private lateinit var sync: SyncManager
    private lateinit var realtime: RealtimeClient

    private lateinit var liveChip: View
    private lateinit var statusText: TextView
    private lateinit var signInButton: Button
    private lateinit var signOutButton: Button
    private lateinit var syncButton: Button
    private lateinit var addButton: Button
    private lateinit var enableKeyboardButton: Button
    private lateinit var switchKeyboardButton: Button
    private lateinit var cloudSettingsButton: Button
    private lateinit var deleteAccountButton: Button
    private lateinit var anyKeyboardButton: Button
    private lateinit var recycler: RecyclerView
    private lateinit var adapter: SnippetAdapter
    private lateinit var emptyState: View

    /** Receives the file picked for the snippet being edited. */
    private var onAttachmentPicked: ((Uri) -> Unit)? = null
    private val pickAttachment = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) onAttachmentPicked?.invoke(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        SupabaseConfig.load(this)
        auth = AuthManager(this)
        store = SnippetStore(this)
        sync = SyncManager(this, auth, store)
        // Live updates: any change pushed from the cloud triggers a sync + refresh.
        realtime = RealtimeClient(auth) {
            runOnUiThread {
                liveChip.visibility = if (auth.isSignedIn) View.VISIBLE else View.GONE
                runSync()
            }
        }

        statusText = findViewById(R.id.statusText)
        signInButton = findViewById(R.id.signInButton)
        signOutButton = findViewById(R.id.signOutButton)
        syncButton = findViewById(R.id.syncButton)
        addButton = findViewById(R.id.addButton)
        enableKeyboardButton = findViewById(R.id.enableKeyboardButton)
        switchKeyboardButton = findViewById(R.id.switchKeyboardButton)
        cloudSettingsButton = findViewById(R.id.cloudSettingsButton)
        deleteAccountButton = findViewById(R.id.deleteAccountButton)
        anyKeyboardButton = findViewById(R.id.anyKeyboardButton)
        liveChip = findViewById(R.id.liveChip)
        recycler = findViewById(R.id.recycler)
        emptyState = findViewById(R.id.emptyState)

        adapter = SnippetAdapter(
            onEdit = { showEditDialog(it) },
            onDelete = { deleteSnippet(it) },
        )
        recycler.layoutManager = LinearLayoutManager(this)
        recycler.adapter = adapter

        applySystemBarInsets()

        signInButton.setOnClickListener {
            if (!SupabaseConfig.isConfigured()) {
                toast("Connect to the Trexpanda cloud first.")
                showCloudSettingsDialog()
            } else {
                auth.startGoogleSignIn()
            }
        }
        cloudSettingsButton.setOnClickListener { showCloudSettingsDialog() }
        deleteAccountButton.setOnClickListener { confirmDeleteAccount() }
        anyKeyboardButton.setOnClickListener { explainAnyKeyboardMode() }
        signOutButton.setOnClickListener { realtime.stop(); auth.signOut(); refresh() }
        syncButton.setOnClickListener { runSync(manual = true) }
        addButton.setOnClickListener { showEditDialog(null) }
        enableKeyboardButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
        }
        switchKeyboardButton.setOnClickListener {
            (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showInputMethodPicker()
        }

        // Only on a fresh start: after a rotation the code was already exchanged.
        if (savedInstanceState == null) handleAuthRedirect(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthRedirect(intent)
    }

    override fun onResume() {
        super.onResume()
        refresh()
        if (auth.isSignedIn) {
            runSync()
            realtime.start()
        }
    }

    override fun onPause() {
        super.onPause()
        realtime.stop()
    }

    override fun onDestroy() {
        // Each activity instance (e.g. after a rotation) owns these worker threads
        // and HTTP clients; release them or every rotation leaks another set.
        realtime.close()
        sync.close()
        super.onDestroy()
    }

    private fun handleAuthRedirect(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "trexpanda") {
            Thread {
                val ok = try { auth.completeSignIn(data) } catch (_: Exception) { false }
                if (ok) keepLocalSnippetsPrivateToAccount()
                runOnUiThread {
                    toast(if (ok) "Signed in." else "Sign-in failed. Check your connection and try again.")
                    refresh()
                    if (ok) { runSync(manual = true); realtime.start() }
                }
            }.start()
        }
    }

    /**
     * Snippets on this phone belong to the account that synced them. If a
     * DIFFERENT account signs in, start it clean, so one person's snippets are
     * never uploaded into someone else's account.
     */
    private fun keepLocalSnippetsPrivateToAccount() {
        val uid = auth.userId ?: return
        val owner = getSharedPreferences("trexpanda_owner", MODE_PRIVATE)
        val last = owner.getString("uid", null)
        if (last != null && last != uid) { store.clearAll(); UsageStats.reset(this) }
        owner.edit().putString("uid", uid).apply()
    }

    /** Sync now. Only a sync the user asked for (or a failure) shows a message. */
    private fun runSync(manual: Boolean = false) {
        syncButton.isEnabled = false
        sync.sync { success, message ->
            runOnUiThread {
                syncButton.isEnabled = true
                if (message != null && (manual || !success) && message != "Sync already in progress.") toast(message)
                refresh()
            }
        }
    }

    private fun refresh() {
        val signedIn = auth.isSignedIn
        signInButton.visibility = if (signedIn) View.GONE else View.VISIBLE
        signOutButton.visibility = if (signedIn) View.VISIBLE else View.GONE
        syncButton.isEnabled = signedIn
        liveChip.visibility = if (signedIn) View.VISIBLE else View.GONE
        deleteAccountButton.visibility = if (signedIn) View.VISIBLE else View.GONE
        // Store builds ship with the cloud settings baked in, so the developer
        // "paste your Supabase key" screen is only offered on builds without them.
        cloudSettingsButton.visibility =
            if (BuildConfig.SUPABASE_ANON_KEY.isBlank()) View.VISIBLE else View.GONE
        statusText.text = when {
            !SupabaseConfig.isConfigured() -> "Cloud not configured"
            signedIn -> "Signed in as ${auth.userEmail ?: "you"}"
            else -> "Not signed in"
        }
        anyKeyboardButton.text = when {
            !isAnyKeyboardModeOn() -> "Use with Gboard or any keyboard"
            isAnyKeyboardModeRunning() -> "Works with any keyboard: On (tap to manage)"
            else -> "Any-keyboard mode was stopped by the phone: tap to fix"
        }
        val items = store.getPersonal().sortedBy { it.trigger ?: "" }
        val usage = UsageStats.combined(this)
        adapter.submit(items, usage)
        val exp = usage.optJSONObject("totals")?.optLong("expansions") ?: 0L
        findViewById<android.widget.TextView>(R.id.timeSavedText).text =
            if (exp > 0) "⏱ ${UsageStats.formatDuration(UsageStats.minutesSaved(usage))} saved" else ""
        emptyState.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
    }

    /**
     * Android 15+ draws apps edge to edge (mandatory when targeting API 36), so keep
     * content and the "New snippet" button clear of the status and navigation bars.
     */
    private fun applySystemBarInsets() {
        val scroll = findViewById<View>(R.id.scroll)
        // Padding as declared in the layout; insets are added on top of it.
        val baseLeft = scroll.paddingLeft
        val baseTop = scroll.paddingTop
        val baseRight = scroll.paddingRight
        val baseBottom = scroll.paddingBottom
        val fabMargin = (20 * resources.displayMetrics.density).toInt()
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            scroll.updatePadding(
                left = baseLeft + bars.left,
                top = baseTop + bars.top,
                right = baseRight + bars.right,
                bottom = baseBottom + bars.bottom,
            )
            addButton.updateLayoutParams<android.view.ViewGroup.MarginLayoutParams> {
                bottomMargin = fabMargin + bars.bottom
                marginEnd = fabMargin + bars.right
            }
            insets
        }
    }

    // ---- any-keyboard mode (accessibility service) -----------------------------

    /** Prominent disclosure (required by Google Play) before the user turns it on. */
    private fun explainAnyKeyboardMode() {
        AlertDialog.Builder(this)
            .setTitle("Use Trexpanda with any keyboard")
            .setMessage(
                "To expand your triggers while you type with Gboard or another keyboard, " +
                "Trexpanda uses Android's Accessibility service.\n\n" +
                "What it does: when you type in a text field, it checks whether the text " +
                "before the cursor ends with one of your triggers and, if so, replaces it " +
                "with your snippet.\n\n" +
                "What it never does: read password fields, store, log or send anything you " +
                "type, or act on anything other than the field you are typing in.\n\n" +
                "On the next screen, tap \"Trexpanda (any keyboard)\" and turn it on. " +
                "You can turn it off there at any time.\n\n" +
                "On Xiaomi, Oppo or Vivo phones, also allow Autostart and set Battery saver " +
                "to \"No restrictions\" (Battery settings), or the phone may stop it."
            )
            .setPositiveButton("Open settings") { _, _ ->
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            .setNeutralButton("Battery settings") { _, _ ->
                // Xiaomi, Oppo, Vivo etc. stop background services unless the app
                // is allowed to run: open this app's settings page.
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.fromParts("package", packageName, null)))
            }
            .setNegativeButton("Not now", null)
            .show()
    }

    /** Turned on AND actually running (Android lists only bound, working services here). */
    private fun isAnyKeyboardModeRunning(): Boolean {
        val am = getSystemService(Context.ACCESSIBILITY_SERVICE) as android.view.accessibility.AccessibilityManager
        val me = TrexpandaAccessibilityService::class.java.name
        return am.getEnabledAccessibilityServiceList(android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { it.resolveInfo?.serviceInfo?.let { si -> si.packageName == packageName && si.name == me } == true }
    }

    private fun isAnyKeyboardModeOn(): Boolean {
        val enabled = Settings.Secure.getString(
            contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val me = "$packageName/${TrexpandaAccessibilityService::class.java.name}"
        return enabled.split(':').any { it.equals(me, ignoreCase = true) }
    }

    // ---- account deletion ----------------------------------------------------

    private fun confirmDeleteAccount() {
        AlertDialog.Builder(this)
            .setTitle("Delete your account?")
            .setMessage(
                "This permanently deletes your Trexpanda account and everything stored in " +
                "the cloud: your synced snippets, shared libraries, friends and profile. " +
                "It can't be undone.\n\nSnippets already on this phone stay on this phone."
            )
            .setPositiveButton("Delete account") { _, _ -> deleteAccount() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun deleteAccount() {
        deleteAccountButton.isEnabled = false
        Thread {
            val result = try {
                Result.success(SupabaseClient(auth).deleteAccount())
            } catch (e: Exception) {
                Result.failure(e)
            }
            runOnUiThread {
                deleteAccountButton.isEnabled = true
                result.onSuccess { refusal ->
                    if (refusal == null) {
                        realtime.stop()
                        auth.signOut()
                        refresh()
                        toast("Your account has been deleted.")
                    } else {
                        AlertDialog.Builder(this)
                            .setTitle("Can't delete yet")
                            .setMessage(refusal)
                            .setPositiveButton("OK", null)
                            .show()
                    }
                }.onFailure {
                    toast("Couldn't delete your account. Check your connection and try again.")
                }
            }
        }.start()
    }

    // ---- cloud settings ------------------------------------------------------

    private fun showCloudSettingsDialog() {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        val urlInput = EditText(this).apply {
            hint = "Supabase URL"
            setText(SupabaseConfig.currentUrl())
            setSingleLine()
        }
        val keyInput = EditText(this).apply {
            hint = "Cloud access key"
            setText(SupabaseConfig.currentAnonKey())
        }
        container.addView(urlInput)
        container.addView(keyInput)

        AlertDialog.Builder(this)
            .setTitle("Cloud settings")
            .setMessage("Paste the Trexpanda cloud access key to enable sign-in and cross-device sync.")
            .setView(container)
            .setPositiveButton("Save") { _, _ ->
                SupabaseConfig.save(this, urlInput.text.toString(), keyInput.text.toString())
                toast(if (SupabaseConfig.isConfigured()) "Cloud enabled. You can sign in now." else "URL and key are required.")
                refresh()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ---- snippet editing -----------------------------------------------------

    private fun showEditDialog(existing: Snippet?) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_edit_snippet, null)
        val triggerInput = view.findViewById<EditText>(R.id.triggerInput)
        val replacementInput = view.findViewById<EditText>(R.id.replacementInput)
        val labelInput = view.findViewById<EditText>(R.id.labelInput)
        val enabledCheck = view.findViewById<CompoundButton>(R.id.enabledCheck)
        val attachmentName = view.findViewById<TextView>(R.id.attachmentName)
        val attachButton = view.findViewById<Button>(R.id.attachButton)
        val removeAttachment = view.findViewById<Button>(R.id.removeAttachmentButton)

        // The image/file synced with this snippet (same 1 MB limit as the desktop app).
        var attachment: String? = existing?.attachment
        fun showAttachment() {
            val att = SnippetAttachment.parse(attachment)
            attachmentName.text = if (att == null) "No attachment"
                else "📎 " + att.name + (if (att.isImage) " (image)" else " (file)")
            attachButton.text = if (att == null) "📎 Attach image or file" else "Replace"
            removeAttachment.visibility = if (att == null) View.GONE else View.VISIBLE
        }
        showAttachment()
        attachButton.setOnClickListener {
            onAttachmentPicked = { uri ->
                val att = readAttachment(uri)
                if (att != null) { attachment = att.toJson(); showAttachment() }
            }
            try { pickAttachment.launch(arrayOf("*/*")) } catch (_: Exception) { toast("No file picker available.") }
        }
        removeAttachment.setOnClickListener { attachment = null; showAttachment() }

        existing?.let {
            triggerInput.setText(it.trigger)
            replacementInput.setText(it.replacement)
            labelInput.setText(it.label)
            enabledCheck.isChecked = it.enabled
        }

        AlertDialog.Builder(this)
            .setTitle(if (existing == null) "New snippet" else "Edit snippet")
            .setView(view)
            .setPositiveButton("Save") { _, _ ->
                val trigger = triggerInput.text.toString().trim()
                val replacement = replacementInput.text.toString()
                if (trigger.isEmpty()) { toast("Trigger is required."); return@setPositiveButton }
                val label = labelInput.text.toString().trim().ifEmpty { null }
                val updated = (existing ?: Snippet(id = "", trigger = trigger)).copy(
                    trigger = trigger,
                    replacement = replacement,
                    // The phone edits plain text; drop stale rich text when the text
                    // changed, or the desktop would keep typing the old version.
                    html = if (existing != null && existing.replacement != replacement) null else existing?.html,
                    label = label,
                    attachment = attachment,
                    attachmentCleared = attachment == null &&
                        (existing?.attachment != null || existing?.attachmentCleared == true),
                    enabled = enabledCheck.isChecked,
                )
                saveSnippet(existing, updated)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /** Read a picked file into an attachment, or explain why it can't be used. */
    private fun readAttachment(uri: Uri): SnippetAttachment? = try {
        var name = "attachment"
        var size = -1L
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.let { name = it }
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        if (size > SnippetAttachment.MAX_BYTES) {
            toast("That file is too large (max 1 MB)."); null
        } else {
            val bytes = contentResolver.openInputStream(uri)?.use { input ->
                val buf = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(16 * 1024)
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    buf.write(chunk, 0, n)
                    if (buf.size() > SnippetAttachment.MAX_BYTES) break
                }
                buf.toByteArray()
            }
            when {
                bytes == null || bytes.isEmpty() -> { toast("Couldn't read that file."); null }
                bytes.size > SnippetAttachment.MAX_BYTES -> { toast("That file is too large (max 1 MB)."); null }
                else -> SnippetAttachment.fromBytes(bytes, name, contentResolver.getType(uri))
            }
        }
    } catch (_: Exception) {
        toast("Couldn't read that file."); null
    }

    private fun saveSnippet(existing: Snippet?, updated: Snippet) {
        val list = store.getPersonal().toMutableList()
        val idx = if (existing != null) list.indexOfFirst { it.id == existing.id } else -1
        if (idx >= 0) list[idx] = updated else list.add(updated)
        store.setPersonal(list)
        refresh()
        if (auth.isSignedIn) runSync()
    }

    private fun deleteSnippet(snippet: Snippet) {
        val list = store.getPersonal().filter { it.id != snippet.id }
        store.setPersonal(list)
        refresh()
        if (auth.isSignedIn) runSync()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
