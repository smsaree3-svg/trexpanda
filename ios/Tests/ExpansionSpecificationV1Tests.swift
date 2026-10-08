import XCTest
import Foundation
// The engine and model (Shared/ExpanderEngine.swift, Shared/Snippet.swift) are
// compiled directly into this hostless test bundle, so no host app, App Group
// entitlement, or code signing is needed to run the conformance vectors.

/// Parity tests for the iOS expansion engine, mirroring the desktop
/// (test/expander.test.js) and Android (ExpanderEngineTest.kt) suites so the
/// behavior defined in SPEC-EXPANSION.md is identical on every platform.
///
/// To run on a Mac: the TrexpandaTests target in project.yml already includes
/// this file plus the engine sources. After `xcodegen generate`, run with
/// Product > Test (Cmd+U) or `xcodebuild test -scheme Trexpanda`.
final class ExpansionSpecificationV1Tests: XCTestCase {

    private func snip(_ trigger: String, _ repl: String, enabled: Bool = true, deleted: Bool = false) -> Snippet {
        // `deletedAt` is the stored field; `isDeleted` is a get-only computed property.
        Snippet(id: UUID().uuidString, trigger: trigger, replacement: repl, enabled: enabled, deletedAt: deleted ? 1 : nil)
    }

    func testFiresOnFullTrigger() {
        let e = ExpanderEngine(snippets: [snip(";hi", "Hello")])
        let a = e.matchSuffix("say ;hi")
        XCTAssertNotNil(a)
        XCTAssertEqual(a?.replacement, "Hello")
        XCTAssertEqual(a?.backspaces, 3)
    }

    func testLongestTriggerWins() {
        let e = ExpanderEngine(snippets: [snip(";x", "SHORT"), snip("a;x", "LONG")])
        XCTAssertEqual(e.matchSuffix("a;x")?.replacement, "LONG")
    }

    func testCaseInsensitive() {
        let e = ExpanderEngine(snippets: [snip(";ch", "Chennai")])
        XCTAssertEqual(e.matchSuffix("go ;CH")?.replacement, "Chennai")
        XCTAssertEqual(e.matchSuffix("go ;Ch")?.trigger, ";ch")
    }

    func testDateToken() {
        let e = ExpanderEngine(snippets: [snip(";d", "{date}")])
        let a = e.matchSuffix(";d")
        XCTAssertNotNil(a?.replacement.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression))
    }

    func testUnknownTokenUntouched() {
        let e = ExpanderEngine(snippets: [snip(";v", "Hi {name}, on {date}")])
        let a = e.matchSuffix(";v")
        XCTAssertTrue(a?.replacement.hasPrefix("Hi {name}, on ") ?? false)
    }

    func testCursorMarker() {
        let e = ExpanderEngine(snippets: [snip(";sig", "Dear $|,\nRegards")])
        let a = e.matchSuffix(";sig")
        XCTAssertEqual(a?.replacement, "Dear ,\nRegards")
        XCTAssertEqual(a?.caretBack, ",\nRegards".count)
    }

    func testExtraCursorMarkersStripped() {
        let e = ExpanderEngine(snippets: [snip(";m", "a$|b$|c")])
        let a = e.matchSuffix(";m")
        XCTAssertEqual(a?.replacement, "abc")
        XCTAssertEqual(a?.caretBack, 2)
    }

    func testEmptyReplacementDeletesTrigger() {
        let e = ExpanderEngine(snippets: [snip(";x", "")])
        let a = e.matchSuffix(";x")
        XCTAssertEqual(a?.replacement, "")
        XCTAssertEqual(a?.backspaces, 2)
    }

    func testDuplicateTriggerCaseInsensitiveLastWins() {
        // SPEC V4: ";test"->First then ";TEST"->Second collapse to one trigger; last wins.
        let e = ExpanderEngine(snippets: [snip(";test", "First"), snip(";TEST", "Second")])
        XCTAssertEqual(e.matchSuffix("go ;test")?.replacement, "Second")
        XCTAssertEqual(e.matchSuffix("go ;TEST")?.replacement, "Second")
    }

    func testDisabledAndDeletedNeverFire() {
        XCTAssertNil(ExpanderEngine(snippets: [snip(";off", "NO", enabled: false)]).matchSuffix(";off"))
        XCTAssertNil(ExpanderEngine(snippets: [snip(";del", "NO", deleted: true)]).matchSuffix(";del"))
    }

    func testMultilineUnicodeVerbatim() {
        let e = ExpanderEngine(snippets: [snip(";m", "Line 1\nLíne 2 ✨\n日本語")])
        XCTAssertEqual(e.matchSuffix(";m")?.replacement, "Line 1\nLíne 2 ✨\n日本語")
    }

    func testSuggestionsCaseInsensitivePrefix() {
        let e = ExpanderEngine(snippets: [snip(";Addr", "123 Main")])
        let (token, items) = e.suggestions(from: "hi ;AD")
        XCTAssertEqual(token, ";AD")
        XCTAssertEqual(items.first?.trigger, ";Addr")
    }

    // Unicode / emoji cursor vectors: caretBack must be the grapheme-cluster count.
    func testCursorCaretBackGraphemeClusters() {
        let cases: [(after: String, expected: Int, before: String)] = [
            ("abc", 3, "x"),
            ("e\u{0301}", 1, "x"),                                              // e + combining acute
            ("cafe\u{0301}", 4, "x"),                                           // café (combining)
            ("\u{1F600}", 1, "x"),                                              // single emoji
            ("\u{1F1FA}\u{1F1F8}", 1, "x"),                                     // flag (2 cp)
            ("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", 1, "x"),            // ZWJ family (5 cp)
            ("\u{1F44D}\u{1F3FD}", 1, "x"),                                     // skin tone (2 cp)
            ("\u{1F44D}\u{1F3FD}ok", 3, "x"),                                   // emoji + text
            ("y", 1, "cafe\u{0301}"),                                           // unicode before marker
        ]
        for c in cases {
            let e = ExpanderEngine(snippets: [snip(";c", c.before + "$|" + c.after)])
            let a = e.matchSuffix(";c")
            XCTAssertEqual(a?.replacement, c.before + c.after)
            XCTAssertEqual(a?.caretBack, c.expected, "caretBack for \(c.after)")
        }
    }
}
