// swift-tools-version: 6.0
import PackageDescription

// Deployment target 26.0 on purpose: the whole visual language is Liquid Glass
// (`glassEffect`), which does not exist before macOS 26.
let package = Package(
    name: "TabcatGUI",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "TabcatGUI",
            path: "Sources/TabcatGUI",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
