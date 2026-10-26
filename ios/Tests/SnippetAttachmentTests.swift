import XCTest
import Foundation

/// The attachment shape must match what the desktop and Android apps sync.
final class SnippetAttachmentTests: XCTestCase {

    private let desktopRow: [String: Any] = [
        "type": "file", "name": "../../evil/Price list.pdf", "mime": "application/pdf", "data": "JVBERi0xLjQK",
    ]

    func testParsesDesktopShapeAndSanitizesName() throws {
        let att = try XCTUnwrap(SnippetAttachment(json: desktopRow))
        XCTAssertEqual(att.type, "file")
        XCTAssertEqual(att.name, "Price list.pdf")
        XCTAssertEqual(att.bytes, Data("%PDF-1.4\n".utf8))
    }

    func testRejectsInvalid() {
        XCTAssertNil(SnippetAttachment(json: nil))
        XCTAssertNil(SnippetAttachment(json: "x"))
        XCTAssertNil(SnippetAttachment(json: ["type": "video", "data": "AAAA"]))
        XCTAssertNil(SnippetAttachment(json: ["type": "image", "data": ""]))
    }

    func testJsonRoundTripAndLocalCodable() throws {
        let a = SnippetAttachment(bytes: Data([1, 2, 3]), name: "photo.jpg", mime: "image/jpeg")
        XCTAssertTrue(a.isImage)
        XCTAssertEqual(SnippetAttachment(json: a.json), a)
        let s = Snippet(trigger: ";p", replacement: "Hi", attachment: a)
        let decoded = try JSONDecoder().decode(Snippet.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(decoded.attachment, a)
        // Snippets saved by older versions (no attachment key) still load.
        let old = #"{"id":"a","trigger":";x","replacement":"y","enabled":true,"updatedAt":1}"#
        XCTAssertNil(try JSONDecoder().decode(Snippet.self, from: Data(old.utf8)).attachment)
    }

    func testEngineCarriesAttachment() throws {
        let a = try XCTUnwrap(SnippetAttachment(json: desktopRow))
        let engine = ExpanderEngine()
        engine.setSnippets([Snippet(trigger: ";pl", replacement: "Here:", attachment: a)])
        XCTAssertEqual(engine.matchSuffix("see ;pl")?.attachment, a)
        XCTAssertEqual(engine.snippetAction(";pl")?.attachment, a)
    }
}
