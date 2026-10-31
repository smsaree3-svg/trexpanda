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
        /// The snippet's image/file to deliver after the text, if any.
        var attachment: SnippetAttachment? = nil
        /// Fill-in fields to prompt for (empty when the snippet has none). When
        /// non-empty the caller prompts for values, then calls `render` with those
        /// values and the `template` to get the final text.
        var fields: [Field] = []
        /// The raw replacement, so the caller can re-render once it has field values.
        var template: String = ""
    }

    /// A fill-in field: its label and its optional default value.
    struct Field {
        let name: String
        let `default`: String
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
            caretBack: rendered.caretBack,
            attachment: e.snippet.attachment,
            fields: parseFields(e.snippet.replacement),
            template: e.snippet.replacement
        )
    }

    /// Build the action for a known trigger (used when a suggestion chip is tapped).
    func snippetAction(_ trigger: String) -> Action? {
        // Resolve case-insensitively: a tapped suggestion carries the canonical
        // trigger, but accept any-case input too.
        guard let e = byLower[trigger.lowercased()] else { return nil }
        let rendered = render(e.snippet.replacement)
        return Action(trigger: e.trigger, replacement: rendered.text,
                      backspaces: trigger.count, caretBack: rendered.caretBack,
                      attachment: e.snippet.attachment,
                      fields: parseFields(e.snippet.replacement),
                      template: e.snippet.replacement)
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

    /// Expand a replacement. When `values` is given, `{{fields}}` are filled from
    /// it (by label); otherwise each field falls back to its default (or empty).
    /// Fields are substituted BEFORE `{token}` resolution so `{{name}}` is never
    /// mistaken for the inner `{name}` token.
    private func render(_ replacement: String, values: [String: String?]? = nil) -> Rendered {
        var text = resolveTokens(substituteFields(replacement, values: values))
        var caretBack = 0
        if let range = text.range(of: "$|") {
            let after = text[range.upperBound...].replacingOccurrences(of: "$|", with: "")
            caretBack = after.count
            text = String(text[..<range.lowerBound]) + after
        }
        return Rendered(text: text, caretBack: caretBack)
    }

    /// The fill-in field pattern: `{{label}}` or `{{label=default}}`. The label
    /// holds no `{`, `}` or `=`; the optional default holds no `{` or `}`. Double
    /// braces keep this distinct from the single-brace `{date}` dynamic tokens.
    private static let fieldRegex = try? NSRegularExpression(
        pattern: "\\{\\{\\s*([^{}=]+?)\\s*(?:=\\s*([^{}]*?)\\s*)?\\}\\}")

    /// Replace every `{{field}}` using the `values` map (keyed by label); fall back
    /// to the field's default, then to empty. Splices matches in reverse so earlier
    /// ranges stay valid.
    private func substituteFields(_ text: String, values: [String: String?]?) -> String {
        guard let regex = ExpanderEngine.fieldRegex else { return text }
        let ns = text as NSString
        var result = text
        let matches = regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed()
        for m in matches {
            let label = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            let value: String
            if let values = values, let slot = values.index(forKey: label) {
                value = values[slot].value ?? ""
            } else if m.range(at: 2).location != NSNotFound {
                value = ns.substring(with: m.range(at: 2))
            } else {
                value = ""
            }
            if let r = Range(m.range, in: result) { result.replaceSubrange(r, with: value) }
        }
        return result
    }

    /// Re-render a template once the user has supplied fill-in field values. The
    /// UI calls this after prompting; it returns the final text and caret-back the
    /// same way a match does. Mirrors desktop `render(replacement, values)` and
    /// Android `render(replacement, values)`.
    func fill(_ template: String, values: [String: String?]) -> (text: String, caretBack: Int) {
        let r = render(template, values: values)
        return (r.text, r.caretBack)
    }

    /// List the fill-in fields in a replacement, in first-appearance order with
    /// duplicates removed (one prompt per label). Empty when the snippet has none.
    func parseFields(_ replacement: String) -> [Field] {
        guard let regex = ExpanderEngine.fieldRegex else { return [] }
        let ns = replacement as NSString
        var out: [Field] = []
        var seen = Set<String>()
        for m in regex.matches(in: replacement, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            if name.isEmpty || seen.contains(name) { continue }
            seen.insert(name)
            let def = m.range(at: 2).location != NSNotFound ? ns.substring(with: m.range(at: 2)) : ""
            out.append(Field(name: name, default: def))
        }
        return out
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
        // Fixed formats must not follow the phone's calendar or 12/24-hour setting.
        df.locale = Locale(identifier: "en_US_POSIX")
        df.calendar = Calendar(identifier: .gregorian)
        switch name {
        case "date": df.dateFormat = "yyyy-MM-dd"; return df.string(from: now)
        case "time": df.dateFormat = "HH:mm"; return df.string(from: now)
        case "datetime": df.dateFormat = "yyyy-MM-dd HH:mm"; return df.string(from: now)
        default: return nil
        }
    }
}
