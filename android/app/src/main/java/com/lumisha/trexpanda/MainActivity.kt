package com.lumisha.trexpanda

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
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

    private lateinit var statusText: TextView
    private lateinit var signInButton: Button
    private lateinit var signOutButton: Button
    private lateinit var syncButton: Button
    private lateinit var addButton: Button
    private lateinit var enableKeyboardButton: Button
    private lateinit var switchKeyboardButton: Button
    private lateinit var cloudSettingsButton: Button
    private lateinit var recycler: RecyclerView
    private lateinit var adapter: SnippetAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        SupabaseConfig.load(this)
        auth = AuthManager(this)
        store = SnippetStore(this)
        sync = SyncManager(this, auth, store)

        statusText = findViewById(R.id.statusText)
        signInButton = findViewById(R.id.signInButton)
        signOutButton = findViewById(R.id.signOutButton)
        syncButton = findViewById(R.id.syncButton)
        addButton = findViewById(R.id.addButton)
        enableKeyboardButton = findViewById(R.id.enableKeyboardButton)
        switchKeyboardButton = findViewById(R.id.switchKeyboardButton)
        cloudSettingsButton = findViewById(R.id.cloudSettingsButton)
        recycler = findViewById(R.id.recycler)

        adapter = SnippetAdapter(
            onEdit = { showEditDialog(it) },
            onDelete = { deleteSnippet(it) },
        )
        recycler.layoutManager = LinearLayoutManager(this)
        recycler.adapter = adapter

        signInButton.setOnClickListener {
            if (!SupabaseConfig.isConfigured()) {
                toast("Add your Supabase anon key first.")
                showCloudSettingsDialog()
            } else {
                auth.startGoogleSignIn()
            }
        }
        cloudSettingsButton.setOnClickListener { showCloudSettingsDialog() }
        signOutButton.setOnClickListener { auth.signOut(); refresh() }
        syncButton.setOnClickListener { runSync() }
        addButton.setOnClickListener { showEditDialog(null) }
        enableKeyboardButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
        }
        switchKeyboardButton.setOnClickListener {
            (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showInputMethodPicker()
        }

        handleAuthRedirect(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthRedirect(intent)
    }

    override fun onResume() {
        super.onResume()
        refresh()
        if (auth.isSignedIn) runSync()
    }

    private fun handleAuthRedirect(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "trexpanda") {
            Thread {
                val ok = auth.completeSignIn(data)
                runOnUiThread {
                    toast(if (ok) "Signed in." else "Sign-in failed.")
                    refresh()
                    if (ok) runSync()
                }
            }.start()
        }
    }

    private fun runSync() {
        syncButton.isEnabled = false
        sync.sync { success, message ->
            runOnUiThread {
                syncButton.isEnabled = true
                if (message != null) toast(message)
                refresh()
            }
        }
    }

    private fun refresh() {
        val signedIn = auth.isSignedIn
        signInButton.visibility = if (signedIn) View.GONE else View.VISIBLE
        signOutButton.visibility = if (signedIn) View.VISIBLE else View.GONE
        syncButton.isEnabled = signedIn
        statusText.text = when {
            !SupabaseConfig.isConfigured() -> "Cloud not configured"
            signedIn -> "Signed in as ${auth.userEmail ?: "you"}"
            else -> "Not signed in"
        }
        adapter.submit(store.getPersonal().sortedBy { it.trigger ?: "" })
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
            hint = "Supabase anon public key"
            setText(SupabaseConfig.currentAnonKey())
        }
        container.addView(urlInput)
        container.addView(keyInput)

        AlertDialog.Builder(this)
            .setTitle("Cloud settings")
            .setMessage("Paste your Supabase anon (public) key to enable sign-in and cross-device sync. Find it in the Supabase dashboard under Project Settings, API.")
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
        val enabledCheck = view.findViewById<CheckBox>(R.id.enabledCheck)

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
                    label = label,
                    enabled = enabledCheck.isChecked,
                )
                saveSnippet(existing, updated)
            }
            .setNegativeButton("Cancel", null)
            .show()
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
