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
    private var shifted = true
    private var symbols = false
    /// A short message shown in the suggestion bar (e.g. "attachment copied").
    private var notice: String?
    /// Optional button shown with the notice (e.g. "Send PDF" for a file attachment).
    private var noticeAction: (title: String, run: () -> Void)?

    private let suggestionBar = UIStackView()
    private let keyRows = UIStackView()
    private var heightConstraint: NSLayoutConstraint?

    private let letterRows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"].map { $0.map(String.init) }
    private let symbolRows: [[String]] = [
        "1234567890".map(String.init),
        ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""],
        [".", ",", "?", "!", "'", "#", "%"],
    ]

    // MARK: Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(named: "KeyboardBackground") ?? .systemGray5

        suggestionBar.axis = .horizontal
        suggestionBar.spacing = 6
        suggestionBar.distribution = .fillProportionally
        keyRows.axis = .vertical
        keyRows.spacing = 8
        keyRows.distribution = .fillEqually

        let root = UIStackView(arrangedSubviews: [suggestionBar, keyRows])
        root.axis = .vertical
        root.spacing = 6
        root.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 3),
            root.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -3),
            root.topAnchor.constraint(equalTo: view.topAnchor, constant: 6),
            root.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -4),
            suggestionBar.heightAnchor.constraint(equalToConstant: 36),
        ])
        let h = view.heightAnchor.constraint(equalToConstant: 266)
        h.priority = .defaultHigh
        h.isActive = true
        heightConstraint = h
        rebuildKeys()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Reload every time the keyboard appears, so edits in the app apply at once.
        engine.setSnippets(SharedStore.loadSnippets().filter { $0.enabled && !$0.isDeleted })
        rebuildKeys()
        refreshSuggestions()
    }

    override func textDidChange(_ textInput: UITextInput?) {
        super.textDidChange(textInput)
        refreshSuggestions()
    }

    // MARK: Typing

    private func type(_ text: String) {
        notice = nil; noticeAction = nil
        textDocumentProxy.insertText(text)
        if shifted && !symbols { shifted = false; rebuildKeys() }
        expandIfTriggered()
        refreshSuggestions()
    }

    /// If the text before the cursor ends with a trigger, replace it.
    private func expandIfTriggered() {
        let before = textDocumentProxy.documentContextBeforeInput ?? ""
        guard let action = engine.matchSuffix(before) else { return }
        apply(action)
    }

    private func apply(_ action: ExpanderEngine.Action) {
        for _ in 0..<action.backspaces { textDocumentProxy.deleteBackward() }
        textDocumentProxy.insertText(action.replacement)
        if action.caretBack > 0 { textDocumentProxy.adjustTextPosition(byCharacterOffset: -action.caretBack) }
        UIDevice.current.playInputClick()
        if let att = action.attachment { copyAttachment(att, trigger: action.trigger) }
    }

    /// iOS keyboards can only type text. Images go on the clipboard (WhatsApp and
    /// most apps offer Paste for images). Other files (PDF, Excel...) can't be
    /// pasted into chat apps on iPhone, so the bar offers "Send <file>", which
    /// opens Trexpanda's share sheet with the real file.
    private func copyAttachment(_ att: SnippetAttachment, trigger: String) {
        guard hasFullAccess else {
            notice = "Allow Full Access to send this snippet's attachment"
            return
        }
        guard let data = att.bytes else { notice = "Couldn't read this snippet's attachment"; return }
        let ext = (att.name as NSString).pathExtension
        let type = (att.mime.isEmpty ? nil : UTType(mimeType: att.mime))
            ?? (ext.isEmpty ? nil : UTType(filenameExtension: ext))
            ?? (att.isImage ? UTType.png : UTType.data)
        let shareURL = URL(string: "trexpanda://share?trigger=" +
            (trigger.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""))
        if att.isImage, let image = UIImage(data: data) {
            UIPasteboard.general.image = image
            notice = "📎 Image copied. Tap the text box and choose Paste"
        } else {
            let provider = NSItemProvider(item: data as NSData, typeIdentifier: type.identifier)
            provider.suggestedName = att.name
            UIPasteboard.general.setItemProviders([provider], localOnly: false, expirationDate: nil)
            notice = "📎 \(att.name)"
        }
        if let shareURL {
            let kind = att.isImage ? "image" : (ext.isEmpty ? "file" : ext.uppercased())
            noticeAction = ("Send \(kind)", { [weak self] in self?.openContainingApp(shareURL) })
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

    private func useSuggestion(_ trigger: String) {
        // Remove the partial token the user typed, then insert the snippet.
        let before = textDocumentProxy.documentContextBeforeInput ?? ""
        let token = before.split(whereSeparator: { $0.isWhitespace }).last.map(String.init) ?? ""
        guard let action = engine.snippetAction(trigger) else { return }
        for _ in 0..<token.count { textDocumentProxy.deleteBackward() }
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

    // MARK: Keys

    /// One key width as a fraction of the row: ten letter keys plus nine 5-pt gaps fill a row.
    private let unit: CGFloat = 0.092

    private func rebuildKeys() {
        keyRows.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let rows = symbols ? symbolRows : letterRows
        for (i, chars) in rows.enumerated() {
            var keys: [(UIButton, CGFloat)] = []
            if i == 2 {
                keys.append((specialKey(symbols ? "#+=" : (shifted ? "⇧" : "⇪")) { [weak self] in
                    guard let self, !self.symbols else { return }
                    self.shifted.toggle(); self.rebuildKeys()
                }, 1.4))
            }
            for k in chars {
                let label = (shifted && !symbols) ? k.uppercased() : k
                keys.append((charKey(label), 1))
            }
            if i == 2 {
                keys.append((specialKey("⌫") { [weak self] in self?.backspace() }, 1.4))
            }
            keyRows.addArrangedSubview(row(keys))
        }
        var bottom: [(UIButton, CGFloat)] = []
        bottom.append((specialKey(symbols ? "ABC" : "123") { [weak self] in
            guard let self else { return }
            self.symbols.toggle(); self.rebuildKeys()
        }, 1.3))
        if needsInputModeSwitchKey {
            let globe = specialKey("🌐") {}
            globe.accessibilityLabel = "Next keyboard"
            globe.addTarget(self, action: #selector(handleInputModeList(from:with:)), for: .allTouchEvents)
            bottom.append((globe, 1.1))
        }
        bottom.append((specialKey("space") { [weak self] in self?.type(" ") }, needsInputModeSwitchKey ? 4.6 : 5.7))
        bottom.append((specialKey("return") { [weak self] in self?.type("\n") }, 2))
        keyRows.addArrangedSubview(row(bottom))
    }

    /// A centred row: each key's width is a fixed share of the row's width.
    private func row(_ keys: [(UIButton, CGFloat)]) -> UIStackView {
        let r = UIStackView()
        r.axis = .horizontal
        r.spacing = 5
        r.distribution = .fill
        let lead = UIView(), trail = UIView()
        r.addArrangedSubview(lead)
        keys.forEach { r.addArrangedSubview($0.0) }
        r.addArrangedSubview(trail)
        for (b, w) in keys {
            b.widthAnchor.constraint(equalTo: r.widthAnchor, multiplier: unit * w).isActive = true
        }
        trail.widthAnchor.constraint(equalTo: lead.widthAnchor).isActive = true
        return r
    }

    private func charKey(_ label: String) -> UIButton {
        keyButton(label, fill: .systemBackground) { [weak self] in self?.type(label) }
    }

    private func specialKey(_ label: String, _ action: @escaping () -> Void) -> UIButton {
        keyButton(label, fill: .systemGray3, action)
    }

    private func keyButton(_ label: String, fill: UIColor, _ action: @escaping () -> Void) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(label, for: .normal)
        b.setTitleColor(.label, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: label.count > 1 ? 15 : 22)
        b.backgroundColor = fill
        b.layer.cornerRadius = 5
        b.layer.shadowColor = UIColor.black.cgColor
        b.layer.shadowOpacity = 0.25
        b.layer.shadowOffset = CGSize(width: 0, height: 1)
        b.layer.shadowRadius = 0
        b.accessibilityLabel = label == "⌫" ? "Delete" : (label == "⇧" || label == "⇪" ? "Shift" : label)
        b.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return b
    }
}
