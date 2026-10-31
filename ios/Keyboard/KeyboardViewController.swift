import UIKit
import UniformTypeIdentifiers

/// The Trexpanda keyboard. A complete QWERTY keyboard that expands your snippet
/// triggers as you type, with a suggestion bar for triggers that start with what
/// you've typed. Matching is stateless: after every key it asks the shared
/// ExpanderEngine about the text before the cursor, exactly like Android.
///
/// It reads snippets from the App Group container, which iOS only allows once
/// the user turns on "Allow Full Access". Without it, the keyboard still types
/// and shows a short hint. It never stores or sends what you type.
final class KeyboardViewController: UIInputViewController {

    private let engine = ExpanderEngine()
    private var loadedSnippets: [Snippet] = []
    private var shifted = true
    private var symbols = false
    /// A short message shown in the suggestion bar (e.g. "attachment copied").
    private var notice: String?
    /// After an image snippet: its text, offered as the photo's caption when the
    /// keyboard next appears in an empty box (e.g. WhatsApp's photo screen after Paste).
    private var pendingCaption: (text: String, until: Date)? {
        get {
            guard let u = Self.captionURL, let d = try? Data(contentsOf: u),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let t = o["text"] as? String, let until = o["until"] as? Double else { return nil }
            return (t, Date(timeIntervalSince1970: until))
        }
        set {
            guard let u = Self.captionURL else { return }
            if let v = newValue, let d = try? JSONSerialization.data(withJSONObject: ["text": v.text, "until": v.until.timeIntervalSince1970]) {
                try? d.write(to: u, options: .atomic)
            } else { try? FileManager.default.removeItem(at: u) }
        }
    }
    /// Kept in the shared container: the photo screen can open a fresh keyboard instance.
    private static var captionURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedStore.appGroup)?
            .appendingPathComponent("pending-caption.json")
    }
    /// Optional button shown with the notice (e.g. "Send PDF" for a file attachment).
    private var noticeAction: (title: String, run: () -> Void)?

    private let suggestionBar = UIStackView()
    private let keysView = UIView()
    private var heightConstraint: NSLayoutConstraint?

    // Same layouts as the iPhone keyboard (letters, 123 and #+= pages).
    private let letterRows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"].map { $0.map(String.init) }
    private let numberRows: [[String]] = [
        "1234567890".map(String.init),
        ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""],
        [".", ",", "?", "!", "'"],
    ]
    private let moreSymbolRows: [[String]] = [
        ["[", "]", "{", "}", "#", "%", "^", "*", "+", "="],
        ["_", "\\", "|", "~", "<", ">", "€", "£", "¥", "•"],
        [".", ",", "?", "!", "'"],
    ]

    // MARK: Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        // Clear, so the system's own keyboard backdrop shows (same as Apple's keyboard).
        view.backgroundColor = .clear

        suggestionBar.axis = .horizontal
        suggestionBar.spacing = 6
        suggestionBar.distribution = .fillProportionally
        suggestionBar.translatesAutoresizingMaskIntoConstraints = false
        keysView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(suggestionBar)
        view.addSubview(keysView)
        NSLayoutConstraint.activate([
            suggestionBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            suggestionBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6),
            suggestionBar.topAnchor.constraint(equalTo: view.topAnchor, constant: 4),
            suggestionBar.heightAnchor.constraint(equalToConstant: 38),
            keysView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            keysView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            keysView.topAnchor.constraint(equalTo: suggestionBar.bottomAnchor, constant: 2),
            keysView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])
        let h = view.heightAnchor.constraint(equalToConstant: 262)
        h.priority = .defaultHigh
        h.isActive = true
        heightConstraint = h
        rebuildKeys()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutKeys()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Reload every time the keyboard appears, so edits in the app apply at once.
        loadedSnippets = SharedStore.loadKeyboardSnippets().filter { $0.enabled && !$0.isDeleted }
        engine.setSnippets(loadedSnippets)
        offerCaptionIfEmptyField()
        symbols = false; moreSymbols = false; capsLock = false
        shifted = shouldAutoCapitalize()
        rebuildKeys()
        refreshSuggestions()
    }

    override func textDidChange(_ textInput: UITextInput?) {
        super.textDidChange(textInput)
        updateAutoShift()
        offerCaptionIfEmptyField()
        refreshSuggestions()
    }

    /// iOS keyboards can't insert photos, so an image snippet works in two taps:
    /// Paste (WhatsApp opens its photo screen), then "Add text" puts the snippet's
    /// text in the caption, the same result Android gives in one step.
    private func offerCaptionIfEmptyField() {
        guard let pc = pendingCaption else { return }
        if Date() > pc.until { pendingCaption = nil; return }
        let before = textDocumentProxy.documentContextBeforeInput ?? ""
        let after = textDocumentProxy.documentContextAfterInput ?? ""
        guard before.isEmpty && after.isEmpty else { return }
        notice = "Add the snippet's text as the caption"
        noticeAction = ("Add text", { [weak self] in
            guard let self else { return }
            self.textDocumentProxy.insertText(pc.text)
            self.pendingCaption = nil
            self.notice = nil; self.noticeAction = nil
            self.refreshSuggestions()
        })
    }

    // MARK: Typing

    private func type(_ text: String) {
        notice = nil; noticeAction = nil
        textDocumentProxy.insertText(text)
        expandIfTriggered()
        // Like Apple's keyboard: back to letters after a space or a quote on the 123 page.
        if symbols && (text == " " || text == "'") { symbols = false; moreSymbols = false; rebuildKeys() }
        updateAutoShift()
        refreshSuggestions()
    }

    /// If the text before the cursor ends with a trigger, replace it.
    private func expandIfTriggered() {
        let before = textDocumentProxy.documentContextBeforeInput ?? ""
        guard let action = engine.matchSuffix(before) else { return }
        apply(action)
    }

    private func apply(_ action: ExpanderEngine.Action) {
        if action.backspaces > 0 {
            let before = textDocumentProxy.documentContextBeforeInput ?? ""
            deleteTyped(String(before.suffix(action.backspaces)), count: action.backspaces)
        }
        textDocumentProxy.insertText(action.replacement)
        if action.caretBack > 0 {
            // The proxy's offset counts UTF-16 units, not Characters (an emoji after
            // `$|` would otherwise leave the caret in the wrong place).
            let tail = action.replacement.suffix(action.caretBack)
            textDocumentProxy.adjustTextPosition(byCharacterOffset: -tail.utf16.count)
        }
        UIDevice.current.playInputClick()
        recordUse(action, typed: action.backspaces)
        lastExpandedText = action.replacement
        if let att = action.attachment { copyAttachment(fullAttachment(att, trigger: action.trigger), trigger: action.trigger) }
    }

    /// iOS keyboards can only type text. Images go on the clipboard (WhatsApp and
    /// most apps offer Paste for images). Other files (PDF, Excel...) can't be
    /// pasted into chat apps on iPhone, so the bar offers "Send <file>", which
    /// opens Trexpanda's share sheet with the real file.
    /// The keyboard's snippet list carries attachments without their data (memory);
    /// read the real file only now, when this snippet is used.
    private func fullAttachment(_ att: SnippetAttachment, trigger: String) -> SnippetAttachment {
        guard att.data.isEmpty else { return att }
        let lc = trigger.lowercased()
        guard let id = loadedSnippets.first(where: { $0.trigger.lowercased() == lc && $0.attachment != nil })?.id,
              let full = SharedStore.loadAttachment(snippetId: id) else { return att }
        return full
    }

    private func copyAttachment(_ att: SnippetAttachment, trigger: String) {
        guard hasFullAccess else {
            notice = "Allow Full Access to send this snippet's attachment"
            return
        }
        guard let data = att.bytes, !data.isEmpty else { notice = "Open Trexpanda once to finish setting up this attachment"; return }
        let ext = (att.name as NSString).pathExtension
        let type = (att.mime.isEmpty ? nil : UTType(mimeType: att.mime))
            ?? (ext.isEmpty ? nil : UTType(filenameExtension: ext))
            ?? (att.isImage ? UTType.png : UTType.data)
        let shareURL = URL(string: "trexpanda://share?trigger=" +
            (trigger.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""))
        if att.isImage, let image = UIImage(data: data) {
            UIPasteboard.general.image = image
            if !lastExpandedText.isEmpty { pendingCaption = (lastExpandedText, Date().addingTimeInterval(180)) }
            notice = "📎 Image copied. Tap the text box and choose Paste"
        } else {
            let provider = NSItemProvider(item: data as NSData, typeIdentifier: type.identifier)
            provider.suggestedName = att.name
            UIPasteboard.general.setItemProviders([provider], localOnly: false, expirationDate: nil)
            notice = "📎 \(att.name)"
        }
        if let shareURL {
            let kind = att.isImage ? "image" : (ext.isEmpty ? "file" : ext.uppercased())
            noticeAction = ("Send \(kind) + text", { [weak self] in self?.openContainingApp(shareURL) })
        }
    }

    /// Open Trexpanda itself. Keyboards have no public API for this; walking the
    /// responder chain to the application object is the standard approach.
    private func openContainingApp(_ url: URL) {
        let sel = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let r = responder {
            if r.responds(to: sel), let obj = r as? NSObject, NSStringFromClass(Swift.type(of: obj)).contains("Application") {
                typealias OpenFn = @convention(c) (NSObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?) -> Void
                let fn = unsafeBitCast(obj.method(for: sel), to: OpenFn.self)
                fn(obj, sel, url as NSURL, NSDictionary(), nil)
                return
            }
            responder = r.next
        }
        notice = "Open the Trexpanda app to send this file"
        noticeAction = nil
        refreshSuggestions()
    }

    private func backspace() {
        notice = nil; noticeAction = nil
        textDocumentProxy.deleteBackward()
        updateAutoShift()
        refreshSuggestions()
    }

    // MARK: Suggestions

    private func refreshSuggestions() {
        suggestionBar.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if !hasFullAccess || !SharedStore.isAvailable {
            suggestionBar.addArrangedSubview(hint("Turn on Allow Full Access in Settings to use your snippets"))
            return
        }
        if let notice {
            suggestionBar.addArrangedSubview(hint(notice))
            if let action = noticeAction {
                let b = UIButton(type: .system)
                b.setTitle(action.title, for: .normal)
                b.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
                b.backgroundColor = UIColor.systemBlue
                b.setTitleColor(.white, for: .normal)
                b.layer.cornerRadius = 8
                b.contentEdgeInsets = UIEdgeInsets(top: 4, left: 12, bottom: 4, right: 12)
                b.setContentCompressionResistancePriority(.required, for: .horizontal)
                b.addAction(UIAction { _ in action.run() }, for: .touchUpInside)
                suggestionBar.addArrangedSubview(b)
            }
            return
        }
        let before = textDocumentProxy.documentContextBeforeInput ?? ""
        let (_, items) = engine.suggestions(from: before, limit: 3)
        if items.isEmpty {
            suggestionBar.addArrangedSubview(hint(""))
            return
        }
        for item in items {
            let b = UIButton(type: .system)
            b.setTitle(item.trigger, for: .normal)
            b.titleLabel?.font = .monospacedSystemFont(ofSize: 15, weight: .semibold)
            b.accessibilityHint = item.preview
            b.backgroundColor = UIColor.secondarySystemBackground
            b.layer.cornerRadius = 8
            b.addAction(UIAction { [weak self] _ in self?.useSuggestion(item.trigger) }, for: .touchUpInside)
            suggestionBar.addArrangedSubview(b)
        }
    }

    /// Count the expansion for the "Uses" and time-saved figures (needs Full Access).
    private func recordUse(_ action: ExpanderEngine.Action, typed: Int) {
        guard hasFullAccess else { return }
        let lc = action.trigger.lowercased()
        let key = loadedSnippets.first { $0.trigger.lowercased() == lc }?.id ?? ("t:" + action.trigger)
        UsageLog.record(key: key, typedChars: max(typed, lastSuggestionTyped), outChars: action.replacement.count)
        lastSuggestionTyped = 0
    }
    private var lastSuggestionTyped = 0
    private var lastExpandedText = ""

    /// Delete the `count` characters the user typed (`typed`). In Hindi and other
    /// Indic scripts one deleteBackward can remove only part of a character (a
    /// vowel sign), leaving pieces of the trigger behind. When that happens, keep
    /// deleting, but only while the text still visibly holds the leftover pieces;
    /// if the app doesn't report its text right away, never guess.
    private func deleteTyped(_ typed: String, count: Int) {
        guard count > 0 else { return }
        let before0 = textDocumentProxy.documentContextBeforeInput ?? ""
        for _ in 0..<count { textDocumentProxy.deleteBackward() }
        let scalars = typed.unicodeScalars.count
        let extra = scalars - count
        guard extra > 0, !typed.isEmpty, before0.hasSuffix(typed) else { return }
        let target = String(String.UnicodeScalarView(before0.unicodeScalars.dropLast(scalars)))
        for _ in 0..<extra {
            let now = textDocumentProxy.documentContextBeforeInput ?? ""
            if now == before0 { return }                                   // not updated yet: don't guess
            guard now.unicodeScalars.count > target.unicodeScalars.count,
                  now.unicodeScalars.starts(with: target.unicodeScalars) else { return }
            textDocumentProxy.deleteBackward()
        }
    }

    private func useSuggestion(_ trigger: String) {
        // Remove the partial token the user typed, then insert the snippet.
        let before = textDocumentProxy.documentContextBeforeInput ?? ""
        let token = before.split(whereSeparator: { $0.isWhitespace }).last.map(String.init) ?? ""
        guard let action = engine.snippetAction(trigger) else { return }
        deleteTyped(token, count: token.count)
        lastSuggestionTyped = token.count
        apply(ExpanderEngine.Action(trigger: action.trigger, replacement: action.replacement,
                                    backspaces: 0, caretBack: action.caretBack,
                                    attachment: action.attachment))
        refreshSuggestions()
    }

    private func hint(_ text: String) -> UILabel {
        let l = UILabel()
        l.text = text
        l.font = .systemFont(ofSize: 12)
        l.textColor = .secondaryLabel
        l.textAlignment = .center
        l.adjustsFontSizeToFitWidth = true
        return l
    }

    // MARK: Keys — same geometry, colours and behaviour as the iPhone keyboard

    private enum KeyKind { case char(String), shift, delete, mode, globe, space, ret }

    /// A key whose touch area also covers half the gap around it, like Apple's keys,
    /// so taps between keys still land.
    private final class KeyButton: UIButton {
        var kind: KeyKind = .space
        var special = false
        override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
            bounds.insetBy(dx: -3, dy: -6).contains(point)
        }
    }

    private var rowsOfKeys: [[KeyButton]] = []
    private var capsLock = false
    private var moreSymbols = false
    private var lastShiftTap = Date.distantPast
    private var lastSpaceTap = Date.distantPast
    private var deleteTimer: Timer?

    private static let charColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.42, alpha: 1) : .white }
    private static let specialColor = UIColor {
        $0.userInterfaceStyle == .dark ? UIColor(white: 0.27, alpha: 1) : UIColor(red: 0.67, green: 0.69, blue: 0.73, alpha: 1)
    }

    private func rebuildKeys() {
        keysView.subviews.forEach { $0.removeFromSuperview() }
        let upper = (shifted || capsLock) && !symbols
        let rows = !symbols ? letterRows : (moreSymbols ? moreSymbolRows : numberRows)
        var grid: [[KeyButton]] = []
        for (i, chars) in rows.enumerated() {
            var row: [KeyButton] = []
            if i == 2 {
                if symbols {
                    row.append(makeKey(.shift, title: moreSymbols ? "123" : "#+=", special: true))
                } else {
                    let icon = capsLock ? "capslock.fill" : (shifted ? "shift.fill" : "shift")
                    row.append(makeKey(.shift, image: icon, special: true))
                }
            }
            for c in chars { row.append(makeKey(.char(c), title: upper ? c.uppercased() : c, special: false)) }
            if i == 2 { row.append(makeKey(.delete, image: "delete.left", special: true)) }
            grid.append(row)
        }
        var bottom = [makeKey(.mode, title: symbols ? "ABC" : "123", special: true)]
        if needsInputModeSwitchKey {
            let globe = makeKey(.globe, image: "globe", special: true)
            globe.addTarget(self, action: #selector(handleInputModeList(from:with:)), for: .allTouchEvents)
            bottom.append(globe)
        }
        bottom.append(makeKey(.space, title: "space", special: false))
        bottom.append(makeKey(.ret, title: "return", special: true))
        grid.append(bottom)
        rowsOfKeys = grid
        layoutKeys()
    }

    private func makeKey(_ kind: KeyKind, title: String? = nil, image: String? = nil, special: Bool) -> KeyButton {
        let b = KeyButton(type: .custom)
        b.kind = kind
        b.special = special
        b.backgroundColor = special ? Self.specialColor : Self.charColor
        b.layer.cornerRadius = 8.5
        b.layer.cornerCurve = .continuous
        b.layer.shadowColor = UIColor.black.cgColor
        b.layer.shadowOpacity = 0.3
        b.layer.shadowOffset = CGSize(width: 0, height: 1)
        b.layer.shadowRadius = 0
        b.setTitleColor(.label, for: .normal)
        b.tintColor = .label
        if let title {
            b.setTitle(title, for: .normal)
            let isLetter: Bool = { if case .char = kind { return true }; return false }()
            b.titleLabel?.font = isLetter ? .systemFont(ofSize: 23) : .systemFont(ofSize: 16)
        }
        if let image {
            b.setImage(UIImage(systemName: image, withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular)), for: .normal)
        }
        b.accessibilityLabel = {
            switch kind {
            case .char(let c): return c
            case .shift: return symbols ? (moreSymbols ? "Numbers" : "More symbols") : "Shift"
            case .delete: return "Delete"
            case .mode: return symbols ? "Letters" : "Numbers"
            case .globe: return "Next keyboard"
            case .space: return "Space"
            case .ret: return "Return"
            }
        }()
        if case .globe = kind {} else {
            b.addTarget(self, action: #selector(keyDown(_:)), for: .touchDown)
            b.addTarget(self, action: #selector(keyUp(_:)), for: .touchUpInside)
            b.addTarget(self, action: #selector(keyCancel(_:)), for: [.touchUpOutside, .touchCancel, .touchDragExit])
        }
        keysView.addSubview(b)
        return b
    }

    /// Lays the keys out like the iPhone keyboard: 3-pt side margins, 6-pt gaps,
    /// ten equal keys on the top row, the second row inset by half a key, shift and
    /// delete at the edges of the third row, and 123 / space / return at the bottom.
    private func layoutKeys() {
        let W = keysView.bounds.width, H = keysView.bounds.height
        guard W > 0, H > 0, rowsOfKeys.count == 4 else { return }
        let margin: CGFloat = 3, gap: CGFloat = 6, rowGap: CGFloat = 11, top: CGFloat = 6, bottomPad: CGFloat = 3
        let keyH = floor((H - top - bottomPad - 3 * rowGap) / 4)
        let u = (W - 2 * margin - 9 * gap) / 10
        func y(_ r: Int) -> CGFloat { top + CGFloat(r) * (keyH + rowGap) }
        func place(_ keys: [KeyButton], width: CGFloat, row: Int) {
            let total = CGFloat(keys.count) * width + CGFloat(max(keys.count - 1, 0)) * gap
            var x = (W - total) / 2
            for k in keys { k.frame = CGRect(x: x, y: y(row), width: width, height: keyH); x += width + gap }
        }
        place(rowsOfKeys[0], width: u, row: 0)
        place(rowsOfKeys[1], width: u, row: 1)

        let third = rowsOfKeys[2]
        let sideW = round(u * 1.3 + 2)
        third.first?.frame = CGRect(x: margin, y: y(2), width: sideW, height: keyH)
        third.last?.frame = CGRect(x: W - margin - sideW, y: y(2), width: sideW, height: keyH)
        let middle = Array(third.dropFirst().dropLast())
        let room = W - 2 * (margin + sideW + gap * 2)
        let midW = symbols ? min(u * 1.45, (room - CGFloat(middle.count - 1) * gap) / CGFloat(middle.count)) : u
        place(middle, width: midW, row: 2)

        let bottom = rowsOfKeys[3]
        let modeW = round(u * 1.3 + 2), globeW = round(u * 1.1), retW = round(u * 2.3 + gap)
        let fixed = bottom.reduce(CGFloat(0)) { sum, k in
            switch k.kind { case .mode: return sum + modeW; case .globe: return sum + globeW; case .ret: return sum + retW; default: return sum }
        }
        let spaceW = W - 2 * margin - fixed - CGFloat(bottom.count - 1) * gap
        var x = margin
        for k in bottom {
            let w: CGFloat
            switch k.kind { case .mode: w = modeW; case .globe: w = globeW; case .ret: w = retW; default: w = spaceW }
            k.frame = CGRect(x: x, y: y(3), width: w, height: keyH)
            x += w + gap
        }
    }

    @objc private func keyDown(_ b: KeyButton) {
        b.backgroundColor = b.special ? Self.charColor : Self.specialColor
        UIDevice.current.playInputClick()
        if case .delete = b.kind {
            backspace()
            deleteTimer?.invalidate()
            deleteTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { [weak self] _ in
                self?.deleteTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in self?.backspace() }
            }
        }
    }

    @objc private func keyCancel(_ b: KeyButton) {
        b.backgroundColor = b.special ? Self.specialColor : Self.charColor
        deleteTimer?.invalidate(); deleteTimer = nil
    }

    @objc private func keyUp(_ b: KeyButton) {
        keyCancel(b)
        switch b.kind {
        case .char(let c):
            type((shifted || capsLock) && !symbols ? c.uppercased() : c)
        case .shift:
            if symbols { moreSymbols.toggle() }
            else {
                let now = Date()
                if capsLock { capsLock = false; shifted = false }
                else if now.timeIntervalSince(lastShiftTap) < 0.35 { capsLock = true; shifted = true }
                else { shifted.toggle() }
                lastShiftTap = now
            }
            rebuildKeys()
        case .delete:
            break // handled on touch down (with hold-to-repeat)
        case .mode:
            symbols.toggle(); moreSymbols = false
            if !symbols { shifted = shouldAutoCapitalize() }
            rebuildKeys()
        case .space:
            let now = Date()
            let before = textDocumentProxy.documentContextBeforeInput ?? ""
            if now.timeIntervalSince(lastSpaceTap) < 0.35, before.hasSuffix(" "),
               let prev = before.dropLast().last, prev.isLetter || prev.isNumber {
                // Double space types ". " like the iPhone keyboard.
                textDocumentProxy.deleteBackward()
                type(". ")
                lastSpaceTap = .distantPast
            } else {
                type(" ")
                lastSpaceTap = now
            }
        case .ret:
            type("\n")
        case .globe:
            break
        }
    }

    /// Capital letter at the start of a sentence, as the text field asks.
    private func shouldAutoCapitalize() -> Bool {
        let proxy = textDocumentProxy
        let mode = proxy.autocapitalizationType ?? .sentences
        if mode == .none { return false }
        if mode == .allCharacters { return true }
        let before = proxy.documentContextBeforeInput ?? ""
        if before.trimmingCharacters(in: .whitespaces).isEmpty { return true }
        if mode == .words { return before.hasSuffix(" ") || before.hasSuffix("\n") }
        return [". ", "! ", "? ", "\n"].contains { before.hasSuffix($0) }
    }

    private func updateAutoShift() {
        guard !capsLock, !symbols else { return }
        let want = shouldAutoCapitalize()
        if want != shifted { shifted = want; rebuildKeys() }
    }
}
