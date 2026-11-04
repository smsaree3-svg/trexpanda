package com.lumisha.trexpanda

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.DialogInterface
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.format.DateUtils
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.PopupMenu
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePadding
import androidx.core.widget.NestedScrollView
import androidx.core.widget.doAfterTextChanged
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.floatingactionbutton.ExtendedFloatingActionButton
import com.google.android.material.progressindicator.CircularProgressIndicator
import com.google.android.material.snackbar.BaseTransientBottomBar
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.textfield.TextInputLayout
import java.text.NumberFormat

/**
 * The companion app: sign in with Google (Supabase), manage personal snippets,
 * sync them across devices, and enable/switch to the Trexpanda keyboard.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var auth: AuthManager
    private lateinit var store: SnippetStore
    private lateinit var sync: SyncManager
    private lateinit var realtime: RealtimeClient

    private lateinit var root: View
    private lateinit var liveChip: View

    // Account
    private lateinit var signedOutGroup: View
    private lateinit var signedInGroup: View
    private lateinit var statusText: TextView
    private lateinit var accountEmail: TextView
    private lateinit var accountAvatar: TextView
    private lateinit var syncStatusText: TextView
    private lateinit var syncProgress: CircularProgressIndicator
    private lateinit var signInButton: Button
    private lateinit var signOutButton: Button
    private lateinit var syncButton: Button
    private lateinit var cloudSettingsButton: Button
    private lateinit var deleteAccountButton: Button

    // Stats
    private lateinit var statsCard: View
    private lateinit var statTimeSaved: TextView
    private lateinit var statExpansions: TextView
    private lateinit var statSnippets: TextView

    // Setup
    private lateinit var setupDoneRow: View
    private lateinit var setupDoneSummary: TextView
    private lateinit var setupSteps: View
    private lateinit var setupProgressText: TextView
    private lateinit var setupCollapseButton: View
    private lateinit var stepEnableIcon: ImageView
    private lateinit var stepEnableStatus: TextView
    private lateinit var stepSwitchIcon: ImageView
    private lateinit var stepSwitchStatus: TextView
    private lateinit var stepAnyIcon: ImageView
    private lateinit var anyKeyboardStatus: TextView
    private lateinit var enableKeyboardButton: Button
    private lateinit var switchKeyboardButton: Button
    private lateinit var anyKeyboardButton: Button

    // Snippets
    private lateinit var snippetsHeader: TextView
    private lateinit var sortButton: MaterialButton
    private lateinit var searchLayout: TextInputLayout
    private lateinit var searchInput: EditText
    private lateinit var recycler: RecyclerView
    private lateinit var adapter: SnippetAdapter
    private lateinit var emptyState: View
    private lateinit var noMatchesState: View
    private lateinit var noMatchesText: TextView
    private lateinit var noMatchesAddButton: Button
    private lateinit var addButton: ExtendedFloatingActionButton

    /** Current search text and sort order of the list. */
    private var query: String = ""
    private var sortMode = SnippetListUi.Sort.AZ

    /** Setup steps shown even though setup is complete (the user tapped Manage). */
    private var setupExpandedByUser = false

    /** A sync started from this screen is running (drives the progress indicator). */
    private var syncing = false
    private var lastSyncFailed = false

    /**
     * A snippet the user just deleted. It is hidden from the list right away but
     * only removed from the store once the Undo snackbar goes away, so an undo
     * never has to race a sync that already pushed the deletion.
     */
    private var pendingDelete: Snippet? = null
    private var undoBar: Snackbar? = null

    private val uiPrefs by lazy { getSharedPreferences(UI_PREFS, MODE_PRIVATE) }

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

        bindViews()

        sortMode = SnippetListUi.Sort.from(uiPrefs.getString(KEY_SORT, null))
        adapter = SnippetAdapter(
            onEdit = { showEditDialog(it) },
            onDelete = { requestDelete(it) },
            onCopy = { copySnippetText(it) },
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
        findViewById<View>(R.id.emptyAddButton).setOnClickListener { showEditDialog(null) }
        noMatchesAddButton.setOnClickListener {
            showEditDialog(null, prefillTrigger = query.trim().takeIf { SnippetListUi.looksLikeTrigger(it) })
        }
        findViewById<View>(R.id.clearSearchButton).setOnClickListener { clearSearch() }
        enableKeyboardButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
        }
        switchKeyboardButton.setOnClickListener {
            (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showInputMethodPicker()
        }
        findViewById<View>(R.id.setupManageButton).setOnClickListener {
            setupExpandedByUser = true
            refreshSetup()
        }
        setupCollapseButton.setOnClickListener {
            setupExpandedByUser = false
            refreshSetup()
        }

        sortButton.setOnClickListener { showSortMenu() }
        searchInput.doAfterTextChanged {
            query = it?.toString().orEmpty()
            refreshSnippets()
        }
        searchInput.setOnEditorActionListener { v, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                hideKeyboard(v); v.clearFocus(); true
            } else false
        }

        // One-handed use: shrink the "New snippet" button while scrolling down
        // through a long list so it covers less, bring the label back going up.
        findViewById<NestedScrollView>(R.id.scroll).setOnScrollChangeListener(
            NestedScrollView.OnScrollChangeListener { _, _, y, _, oldY ->
                val goingDown = y > oldY + 8
                val goingUp = y < oldY - 8 || y == 0
                if (goingDown && addButton.isExtended) addButton.shrink()
                if (goingUp && !addButton.isExtended) addButton.extend()
            }
        )

        // Only on a fresh start: after a rotation the code was already exchanged.
        if (savedInstanceState == null) handleAuthRedirect(intent)
    }

    private fun bindViews() {
        root = findViewById(R.id.root)
        liveChip = findViewById(R.id.liveChip)

        signedOutGroup = findViewById(R.id.signedOutGroup)
        signedInGroup = findViewById(R.id.signedInGroup)
        statusText = findViewById(R.id.statusText)
        accountEmail = findViewById(R.id.accountEmail)
        accountAvatar = findViewById(R.id.accountAvatar)
        syncStatusText = findViewById(R.id.syncStatusText)
        syncProgress = findViewById(R.id.syncProgress)
        signInButton = findViewById(R.id.signInButton)
        signOutButton = findViewById(R.id.signOutButton)
        syncButton = findViewById(R.id.syncButton)
        cloudSettingsButton = findViewById(R.id.cloudSettingsButton)
        deleteAccountButton = findViewById(R.id.deleteAccountButton)

        statsCard = findViewById(R.id.statsCard)
        statTimeSaved = findViewById(R.id.statTimeSaved)
        statExpansions = findViewById(R.id.statExpansions)
        statSnippets = findViewById(R.id.statSnippets)

        setupDoneRow = findViewById(R.id.setupDoneRow)
        setupDoneSummary = findViewById(R.id.setupDoneSummary)
        setupSteps = findViewById(R.id.setupSteps)
        setupProgressText = findViewById(R.id.setupProgressText)
        setupCollapseButton = findViewById(R.id.setupCollapseButton)
        stepEnableIcon = findViewById(R.id.stepEnableIcon)
        stepEnableStatus = findViewById(R.id.stepEnableStatus)
        stepSwitchIcon = findViewById(R.id.stepSwitchIcon)
        stepSwitchStatus = findViewById(R.id.stepSwitchStatus)
        stepAnyIcon = findViewById(R.id.stepAnyIcon)
        anyKeyboardStatus = findViewById(R.id.anyKeyboardStatus)
        enableKeyboardButton = findViewById(R.id.enableKeyboardButton)
        switchKeyboardButton = findViewById(R.id.switchKeyboardButton)
        anyKeyboardButton = findViewById(R.id.anyKeyboardButton)

        snippetsHeader = findViewById(R.id.snippetsHeader)
        sortButton = findViewById(R.id.sortButton)
        searchLayout = findViewById(R.id.searchLayout)
        searchInput = findViewById(R.id.searchInput)
        recycler = findViewById(R.id.recycler)
        emptyState = findViewById(R.id.emptyState)
        noMatchesState = findViewById(R.id.noMatchesState)
        noMatchesText = findViewById(R.id.noMatchesText)
        noMatchesAddButton = findViewById(R.id.noMatchesAddButton)
        addButton = findViewById(R.id.addButton)
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
        // Leaving the screen ends the undo window: apply a pending delete now.
        commitPendingDelete()
        undoBar?.dismiss()
        undoBar = null
        super.onPause()
        realtime.stop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // The keyboard picker is a system dialog that doesn't pause this screen;
        // re-check the setup steps when focus comes back from it.
        if (hasFocus && ::adapter.isInitialized) refreshSetup()
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
                    snack(if (ok) "Signed in." else "Sign-in failed. Check your connection and try again.")
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
        syncing = true
        updateSyncStatus()
        sync.sync { success, message ->
            runOnUiThread {
                // The sync already running reports back (and re-runs) on its own.
                if (message == "Sync already in progress.") return@runOnUiThread
                syncing = false
                if (success) {
                    lastSyncFailed = false
                    uiPrefs.edit().putLong(KEY_LAST_SYNC, System.currentTimeMillis()).apply()
                } else {
                    lastSyncFailed = auth.isSignedIn
                }
                if (message != null && (manual || !success)) snack(message)
                refresh()
            }
        }
    }

    private fun refresh() {
        refreshAccount()
        refreshSetup()
        refreshSnippets()
    }

    // ---- account -------------------------------------------------------------

    private fun refreshAccount() {
        val signedIn = auth.isSignedIn
        signedOutGroup.visibility = if (signedIn) View.GONE else View.VISIBLE
        signedInGroup.visibility = if (signedIn) View.VISIBLE else View.GONE
        signInButton.visibility = if (signedIn) View.GONE else View.VISIBLE
        signOutButton.visibility = if (signedIn) View.VISIBLE else View.GONE
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
        val email = auth.userEmail
        accountEmail.text = email ?: "Signed in"
        accountAvatar.text = email?.trim()?.firstOrNull()?.uppercaseChar()?.toString() ?: "✓"
        if (!signedIn) { syncing = false; lastSyncFailed = false }
        updateSyncStatus()
    }

    private fun updateSyncStatus() {
        val signedIn = auth.isSignedIn
        syncProgress.visibility = if (syncing && signedIn) View.VISIBLE else View.GONE
        syncButton.isEnabled = signedIn && !syncing
        syncButton.text = if (syncing && signedIn) "Syncing…" else "Sync now"
        val last = uiPrefs.getLong(KEY_LAST_SYNC, 0L)
        syncStatusText.text = when {
            syncing -> "Syncing your snippets…"
            lastSyncFailed -> "Couldn't sync. Check your connection and tap Sync now."
            last > 0L -> "Synced " + relativeTime(last)
            else -> "Not synced yet"
        }
        syncStatusText.setTextColor(
            ContextCompat.getColor(this, if (lastSyncFailed && !syncing) R.color.warning else R.color.muted)
        )
    }

    private fun relativeTime(time: Long): String {
        val now = System.currentTimeMillis()
        return if (now - time < DateUtils.MINUTE_IN_MILLIS) "just now"
        else DateUtils.getRelativeTimeSpanString(time, now, DateUtils.MINUTE_IN_MILLIS).toString()
    }

    // ---- setup (keyboard + any-keyboard mode) -----------------------------------

    private fun refreshSetup() {
        val imeEnabled = isKeyboardEnabled()
        val imeSelected = imeEnabled && isKeyboardSelected()
        val anyOn = isAnyKeyboardModeOn()
        val anyRunning = anyOn && isAnyKeyboardModeRunning()

        setStepState(stepEnableIcon, done = imeEnabled)
        stepEnableStatus.text = if (imeEnabled) "Turned on." else "In Settings, switch on Trexpanda Keyboard."
        enableKeyboardButton.text = if (imeEnabled) "Settings" else "Enable"

        setStepState(stepSwitchIcon, done = imeSelected)
        stepSwitchStatus.text = when {
            imeSelected -> "Trexpanda is your keyboard right now."
            !imeEnabled -> "After step 1, pick Trexpanda as your keyboard."
            else -> "Pick Trexpanda as your keyboard."
        }

        setStepState(stepAnyIcon, done = anyRunning, warn = anyOn && !anyRunning)
        anyKeyboardStatus.text = when {
            !anyOn -> "Optional. Expands your triggers while you type with your usual keyboard."
            anyRunning -> "On. Your triggers expand in any keyboard."
            else -> "Stopped by the phone. Tap below to turn it back on."
        }
        anyKeyboardButton.text = when {
            !anyOn -> "Use with Gboard or any keyboard"
            anyRunning -> "Works with any keyboard: On (tap to manage)"
            else -> "Any-keyboard mode was stopped by the phone: tap to fix"
        }

        val complete = (imeEnabled && imeSelected) || anyRunning
        if (!complete) setupExpandedByUser = false
        val showSteps = !complete || setupExpandedByUser
        setupSteps.visibility = if (showSteps) View.VISIBLE else View.GONE
        setupDoneRow.visibility = if (showSteps) View.GONE else View.VISIBLE
        setupCollapseButton.visibility = if (complete && showSteps) View.VISIBLE else View.GONE
        setupProgressText.text = when {
            complete -> "All set. You can start typing triggers."
            else -> "${listOf(imeEnabled, imeSelected).count { it }} of 2 steps done, or turn on any-keyboard mode"
        }
        setupDoneSummary.text = when {
            imeSelected && anyRunning -> "Trexpanda Keyboard and any-keyboard mode are on"
            imeSelected -> "Trexpanda Keyboard is ready"
            else -> "Works with your usual keyboard"
        }
    }

    private fun setStepState(icon: ImageView, done: Boolean, warn: Boolean = false) {
        icon.setImageResource(
            when {
                done -> R.drawable.ic_check_circle
                warn -> R.drawable.ic_warning
                else -> R.drawable.ic_circle_outline
            }
        )
        val color = when {
            done -> R.color.success
            warn -> R.color.warning
            else -> R.color.subtle
        }
        icon.imageTintList = ColorStateList.valueOf(ContextCompat.getColor(this, color))
    }

    /** Trexpanda Keyboard is switched on in Settings › Keyboards. */
    private fun isKeyboardEnabled(): Boolean = try {
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .enabledInputMethodList.any { it.packageName == packageName }
    } catch (_: Exception) {
        false
    }

    /** Trexpanda Keyboard is the keyboard currently in use. */
    private fun isKeyboardSelected(): Boolean = try {
        val id = Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
        id != null && ComponentName.unflattenFromString(id)?.packageName == packageName
    } catch (_: Exception) {
        false
    }

    // ---- snippet list ------------------------------------------------------------

    private fun refreshSnippets() {
        val hiddenId = pendingDelete?.id
        val all = store.getPersonal().filter { it.id != hiddenId }
        val usage = UsageStats.combined(this)
        val q = query.trim()
        val shown = SnippetListUi.sort(all.filter { SnippetListUi.matches(it, q) }, sortMode, usage)
        adapter.submit(shown, usage)

        // Stats
        val exp = usage.optJSONObject("totals")?.optLong("expansions") ?: 0L
        val saved = if (exp > 0) UsageStats.formatDuration(UsageStats.minutesSaved(usage)) else "0 min"
        statTimeSaved.text = saved
        statExpansions.text = NumberFormat.getIntegerInstance().format(exp)
        statSnippets.text = NumberFormat.getIntegerInstance().format(all.size.toLong())
        findViewById<View>(R.id.statTimeTile).contentDescription = "Time saved: $saved"
        findViewById<View>(R.id.statExpansionsTile).contentDescription = "Expansions: $exp"
        findViewById<View>(R.id.statSnippetsTile).contentDescription = "Snippets: ${all.size}"
        statsCard.visibility = if (all.isEmpty() && exp == 0L) View.GONE else View.VISIBLE

        // Header, search and sort
        snippetsHeader.text = if (all.isEmpty()) "MY SNIPPETS" else "MY SNIPPETS · ${all.size}"
        val hasAny = all.isNotEmpty()
        searchLayout.visibility = if (hasAny) View.VISIBLE else View.GONE
        sortButton.visibility = if (hasAny) View.VISIBLE else View.GONE
        sortButton.text = sortMode.label
        sortButton.contentDescription = "Sort: ${sortMode.label}"

        // Empty states
        emptyState.visibility = if (hasAny) View.GONE else View.VISIBLE
        val noMatches = hasAny && shown.isEmpty()
        noMatchesState.visibility = if (noMatches) View.VISIBLE else View.GONE
        if (noMatches) {
            noMatchesText.text = "No snippets match “$q”"
            noMatchesAddButton.text =
                if (SnippetListUi.looksLikeTrigger(q)) "Create $q" else "New snippet"
        }
    }

    private fun showSortMenu() {
        val popup = PopupMenu(this, sortButton)
        popup.menuInflater.inflate(R.menu.menu_sort, popup.menu)
        val checked = when (sortMode) {
            SnippetListUi.Sort.AZ -> R.id.sort_az
            SnippetListUi.Sort.RECENT -> R.id.sort_recent
            SnippetListUi.Sort.MOST_USED -> R.id.sort_used
        }
        popup.menu.findItem(checked)?.isChecked = true
        popup.setOnMenuItemClickListener { item ->
            val mode = when (item.itemId) {
                R.id.sort_az -> SnippetListUi.Sort.AZ
                R.id.sort_recent -> SnippetListUi.Sort.RECENT
                R.id.sort_used -> SnippetListUi.Sort.MOST_USED
                else -> return@setOnMenuItemClickListener false
            }
            sortMode = mode
            uiPrefs.edit().putString(KEY_SORT, mode.key).apply()
            refreshSnippets()
            true
        }
        popup.show()
    }

    private fun clearSearch() {
        searchInput.setText("")
        searchInput.clearFocus()
        hideKeyboard(searchInput)
    }

    private fun hideKeyboard(v: View) {
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(v.windowToken, 0)
    }

    private fun copySnippetText(s: Snippet) {
        if (s.replacement.isEmpty()) { snack("This snippet has no text to copy."); return }
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(s.label ?: s.trigger ?: "Snippet", s.replacement))
        // Android 13+ shows its own "Copied" confirmation.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) snack("Copied ${s.trigger ?: "snippet"} text.")
    }

    /**
     * Delete with Undo: hide the snippet now, remove it for real when the
     * snackbar goes away without Undo (or the user leaves the screen).
     */
    private fun requestDelete(s: Snippet) {
        commitPendingDelete()
        pendingDelete = s
        refreshSnippets()
        val bar = Snackbar.make(root, "Deleted ${s.trigger ?: "snippet"}", Snackbar.LENGTH_LONG)
            .setAction("Undo") {
                if (pendingDelete?.id == s.id) {
                    pendingDelete = null
                    refreshSnippets()
                }
            }
            .addCallback(object : BaseTransientBottomBar.BaseCallback<Snackbar>() {
                override fun onDismissed(transientBottomBar: Snackbar?, event: Int) {
                    if (undoBar === transientBottomBar) undoBar = null
                    if (event != BaseTransientBottomBar.BaseCallback.DISMISS_EVENT_ACTION && pendingDelete?.id == s.id) commitPendingDelete()
                }
            })
        if (addButton.isShown) bar.anchorView = addButton
        undoBar = bar
        bar.show()
    }

    private fun commitPendingDelete() {
        val s = pendingDelete ?: return
        pendingDelete = null
        deleteSnippet(s)
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
                        snack("Your account has been deleted.")
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

    private fun showEditDialog(existing: Snippet?, prefillTrigger: String? = null) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_edit_snippet, null)
        val triggerLayout = view.findViewById<TextInputLayout>(R.id.triggerLayout)
        val replacementLayout = view.findViewById<TextInputLayout>(R.id.replacementLayout)
        val triggerInput = view.findViewById<EditText>(R.id.triggerInput)
        val replacementInput = view.findViewById<EditText>(R.id.replacementInput)
        val labelInput = view.findViewById<EditText>(R.id.labelInput)
        val enabledCheck = view.findViewById<CompoundButton>(R.id.enabledCheck)
        val previewText = view.findViewById<TextView>(R.id.previewText)
        val attachmentName = view.findViewById<TextView>(R.id.attachmentName)
        val attachButton = view.findViewById<Button>(R.id.attachButton)
        val removeAttachment = view.findViewById<Button>(R.id.removeAttachmentButton)

        // Other snippets, for the "trigger already used" check.
        val others = store.getPersonal().filter { it.id != existing?.id && it.id != pendingDelete?.id }

        // The image/file synced with this snippet (same 1 MB limit as the desktop app).
        var attachment: String? = existing?.attachment

        fun updatePreview() {
            val t = triggerInput.text?.toString()?.trim().orEmpty()
            val r = replacementInput.text?.toString().orEmpty()
            val att = SnippetAttachment.parse(attachment)
            val accent = ContextCompat.getColor(this, R.color.accent)
            val muted = ContextCompat.getColor(this, R.color.muted)
            val sb = SpannableStringBuilder()
            fun span(text: String, vararg spans: Any) {
                val start = sb.length
                sb.append(text)
                spans.forEach { sb.setSpan(it, start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
            }
            if (t.isEmpty() && r.isEmpty() && att == null) {
                span("Type a trigger and the text it should become.", ForegroundColorSpan(muted))
            } else {
                span("Type ", ForegroundColorSpan(muted))
                span(t.ifEmpty { "…" }, TypefaceSpan("monospace"), StyleSpan(Typeface.BOLD), ForegroundColorSpan(accent))
                span("  →\n", ForegroundColorSpan(muted))
                if (r.isEmpty()) span("(no text)", ForegroundColorSpan(muted)) else sb.append(r)
                if (att != null) span("\n📎 " + att.name, ForegroundColorSpan(accent))
                if (!enabledCheck.isChecked) span("\nOff: won't expand until you turn it on.", ForegroundColorSpan(muted))
            }
            previewText.text = sb
        }

        fun showAttachment() {
            val att = SnippetAttachment.parse(attachment)
            attachmentName.text = if (att == null) "No attachment"
                else "📎 " + att.name + (if (att.isImage) " (image)" else " (file)")
            attachButton.text = if (att == null) "📎 Attach image or file" else "Replace"
            removeAttachment.visibility = if (att == null) View.GONE else View.VISIBLE
            updatePreview()
        }
        attachButton.setOnClickListener {
            onAttachmentPicked = { uri ->
                val att = readAttachment(uri)
                if (att != null) { attachment = att.toJson(); replacementLayout.error = null; showAttachment() }
            }
            try { pickAttachment.launch(arrayOf("*/*")) } catch (_: Exception) { toast("No file picker available.") }
        }
        removeAttachment.setOnClickListener { attachment = null; showAttachment() }

        if (existing != null) {
            triggerInput.setText(existing.trigger)
            replacementInput.setText(existing.replacement)
            labelInput.setText(existing.label)
            enabledCheck.isChecked = existing.enabled
        } else if (!prefillTrigger.isNullOrEmpty()) {
            triggerInput.setText(prefillTrigger)
        }
        showAttachment()

        fun triggerError(requireNonEmpty: Boolean): String? = SnippetListUi.triggerError(
            triggerInput.text?.toString().orEmpty(), existing?.trigger, others, requireNonEmpty
        )

        // Live feedback: preview follows typing, trigger problems show as you type.
        triggerInput.doAfterTextChanged {
            triggerLayout.error = triggerError(requireNonEmpty = false)
            updatePreview()
        }
        replacementInput.doAfterTextChanged {
            replacementLayout.error = null
            updatePreview()
        }
        enabledCheck.setOnCheckedChangeListener { _, _ -> updatePreview() }
        // Show a clash right away when opening a pre-filled trigger.
        if (existing == null && !prefillTrigger.isNullOrEmpty()) {
            triggerLayout.error = triggerError(requireNonEmpty = false)
        }

        val builder = MaterialAlertDialogBuilder(this)
            .setTitle(if (existing == null) "New snippet" else "Edit snippet")
            .setView(view)
            // Set below, so a validation error keeps the dialog open.
            .setPositiveButton("Save", null)
            .setNegativeButton("Cancel", null)
        if (existing != null) builder.setNeutralButton("Delete") { _, _ -> requestDelete(existing) }
        val dialog = builder.create()

        dialog.setOnShowListener {
            dialog.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener {
                val trigger = triggerInput.text?.toString().orEmpty().trim()
                val replacement = replacementInput.text?.toString().orEmpty()

                val tErr = triggerError(requireNonEmpty = true)
                triggerLayout.error = tErr
                // Text is required unless there's an attachment, or the text was
                // left as it was (e.g. a rich-text snippet made on the desktop).
                val rErr = if (replacement.isBlank() && attachment == null && existing?.replacement != replacement)
                    "Enter the text to insert, or attach a file." else null
                replacementLayout.error = rErr
                if (tErr != null) { triggerInput.requestFocus(); return@setOnClickListener }
                if (rErr != null) { replacementInput.requestFocus(); return@setOnClickListener }

                val label = labelInput.text?.toString().orEmpty().trim().ifEmpty { null }
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
                dialog.dismiss()
            }
            dialog.getButton(DialogInterface.BUTTON_NEUTRAL)?.setTextColor(ContextCompat.getColor(this, R.color.danger))
        }

        @Suppress("DEPRECATION")
        val softInput = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or
            (if (existing == null) WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE else 0)
        dialog.window?.setSoftInputMode(softInput)
        if (existing == null) triggerInput.requestFocus()
        dialog.show()
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

    /** Toast: for messages shown while a dialog may be on top of the screen. */
    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    /** Snackbar above the "New snippet" button, clear of the navigation bar. */
    private fun snack(msg: String) {
        val bar = Snackbar.make(root, msg, Snackbar.LENGTH_SHORT)
        if (addButton.isShown) bar.anchorView = addButton
        bar.show()
    }

    companion object {
        private const val UI_PREFS = "trexpanda_ui"
        private const val KEY_SORT = "sort"
        private const val KEY_LAST_SYNC = "last_sync_at"
    }
}
