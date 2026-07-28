// swift-tools-version: 6.0
import PackageDescription

// Deployment target 26.0 on purpose: the whole visual language is Liquid Glass
// (`glassEffect`), which does not exist before macOS 26.
let package = Package(
    name: "TabcatGUI",
    platforms: [.macOS("26.0")],
    dependencies: [
        // A real terminal emulator, so cursor addressing, scroll regions and the
        // alternate screen work — vim and `git rebase -i` render, not just `git
        // status`. Writing this ourselves was the wrong trade: the hand-rolled
        // version already failed on an ordinary Symfony progress bar.
        //
        // Pinned to a revision, not a version range: this is ~15k lines of someone
        // else's emulator inside a process that runs shell commands, and a tag can be
        // moved. The revision below is v1.15.0.
        .package(
            url: "https://github.com/migueldeicaza/SwiftTerm",
            revision: "dd2fb8ac5b861e7bf617c872895e338f38165648"
        )
    ],
    targets: [
        .executableTarget(
            name: "TabcatGUI",
            dependencies: [.product(name: "SwiftTerm", package: "SwiftTerm")],
            path: "Sources/TabcatGUI",
            // The wordmark in the launcher's corner. Processed rather than copied, so
            // SwiftPM generates the `Bundle.module` accessor that finds it — the app
            // bundle then has to carry that resource bundle, which `bundle.sh` does.
            resources: [.process("Resources")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
