// swift-tools-version:5.7
import PackageDescription

// Standalone package that runs the iOS engine's ExpansionSpecificationV1
// conformance vectors with `swift test`. The engine (ExpanderEngine.swift) and
// model (Snippet.swift) are the BYTE-IDENTICAL files shipped in the iOS app's
// Shared/ folder; they are compiled directly into the test target (same module),
// so no host app, simulator, code signing, or XcodeGen is required. This runs on
// the Swift toolchain that ships with Xcode.
let package = Package(
    name: "TrexpandaEngineConformance",
    targets: [
        .testTarget(
            name: "TrexpandaEngineTests",
            path: "Tests",
            sources: [
                "ExpanderEngine.swift",
                "Snippet.swift",
                "ExpansionSpecificationV1Tests.swift",
            ]
        )
    ]
)
