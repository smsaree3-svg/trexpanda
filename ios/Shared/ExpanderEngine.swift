import Foundation

/// Pure, dependency-free text-expansion engine. Faithful Swift port of the
/// Android `ExpanderEngine` (itself a port of the desktop `expander.js`).
///
/// It is STATELESS with respect to matching: the keyboard feeds it the actual
/// text before the cursor after each keystroke, so expansion never depends on an
/// internal buffer that the system could reset. Longest matching trigger wins.
final class ExpanderEngine {

    struct Action {
        let trigger: String
        let replacement: String
        let backspaces: Int
        /// How far to move the caret back afterwards (for a `$|` marker), in characters.
        let caretBack: Int
    }

    struct Suggestion {
        let trigger: String
        let preview: String
    }

    /// One active trigger: the canonical (as-typed) spelling and its snippet.
    private struct Entry { let trigger: String; let snippet: Snippet }

    /// Case-insensitive active index: lowercased trigger -> Entry. Triggers match
    /// case-insensitively, so ";ch", ";CH" and ";Ch" are the SAME trigger; exactly
    /// one active snippet exists per lowercased trigger and the LAST definition
    /// wins (SPEC-EXPANSION.md section 5). Matching never needs to lowercase a
    /// trigger on the hot path because the key is already lowercased.
    private var byLower: [String: Entry] = [:]
    private(set) var maxTriggerLen: Int = 1

    init(snippets: [Snippet] = []) { setSnippets(snippets) }

    func setSnippets(_ snippets: [Snippet]) {
        var m: [String: Entry] = [:]
        var maxLen = 1
        for s in snippets {
            let t = s.trigger
            if t.isEmpty || !s.enabled || s.isDeleted { continue }
            m[t.lowercased()] = Entry(trigger: t, snippet: s) // last definition wins
            if t.count > maxLen { maxLen = t.count }
        }
        byLower = m
        maxTriggerLen = maxLen
    }

    /// Stateless match against the actual text before the caret. Longest trigger
    /// wins. Matching is case-insensitive.
    func matchSuffix(_ textBeforeCursor: String) -> Action? {
        let lowerText = textBeforeCursor.lowercased()
        var best: Entry?
        var bestLen = -1
        for (lower, entry) in byLower where lowerText.hasSuffix(lower) {
            if lower.count > bestLen { best = entry; bestLen = lower.count }
        }
        guard let e = best else { return nil }
        let rendered = render(e.snippet.replacement)
        return Action(
            trigger: e.trigger,
            replacement: rendered.text,
            backspaces: e.trigger.count,
            caretBack: rendered.caretBack
        )
    }

    /// Build the action for a known trigger (used when a suggestion chip is tapped).
    func snippetAction(_ trigger: String) -> Action? {
        // Resolve case-insensitively: a tapped suggestion carries the canonical
        // trigger, but accept any-case input too.
        guard let e = byLower[trigger.lowercased()] else { return nil }
        let rendered = render(e.snippet.replacement)
        return Action(trigger: e.trigger, replacement: rendered.text,
                      backspaces: trigger.count, caretBack: rendered.caretBack)
    }

    /// Live suggestions from the last non-space token of the given text.
    func suggestions(from textBeforeCursor: String, limit: Int = 6) -> (token: String, items: [Suggestion]) {
        let token = textBeforeCursor.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).last.map(String.init) ?? ""
        if token.isEmpty { return ("", []) }
        let tokenLower = token.lowercased()
        var items: [Suggestion] = []
        for (lower, entry) in byLower where entry.trigger.count >= token.count && lower.hasPrefix(tokenLower) {
            let preview = entry.snippet.replacement
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            items.append(Suggestion(trigger: entry.trigger, preview: String(preview.prefix(140))))
        }
        items.sort { ($0.trigger.count, $0.trigger) < ($1.trigger.count, $1.trigger) }
        return (token, Array(items.prefix(max(1, limit))))
    }

    // MARK: - Rendering

    private struct Rendered { let text: String; let caretBack: Int }

    private func render(_ replacement: String) -> Rendered {
        var text = resolveTokens(replacement)
        var caretBack = 0
        if let range = text.range(of: "$|") {
            let after = text[range.upperBound...].replacingOccurrences(of: "$|", with: "")
            caretBack = after.count
            text = String(text[..<range.lowerBound]) + after
        }
        return Rendered(text: text, caretBack: caretBack)
    }

    private func resolveTokens(_ input: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "\\{(\\w+)\\}") else { return input }
        let ns = input as NSString
        var result = input
        let matches = regex.matches(in: input, range: NSRange(location: 0, length: ns.length)).reversed()
        for m in matches {
            let name = ns.substring(with: m.range(at: 1))
            if let value = builtinToken(name) {
                let full = ns.substring(with: m.range)
                if let r = result.range(of: full) { result.replaceSubrange(r, with: value) }
            }
        }
        return result
    }

    private func builtinToken(_ name: String) -> String? {
        let now = Date()
        let df = DateFormatter()
        switch name {
        case "date": df.dateFormat = "yyyy-MM-dd"; return df.string(from: now)
        case "time": df.dateFormat = "HH:mm"; return df.string(from: now)
        case "datetime": df.dateFormat = "yyyy-MM-dd HH:mm"; return df.string(from: now)
        default: return nil
        }
    }
}
