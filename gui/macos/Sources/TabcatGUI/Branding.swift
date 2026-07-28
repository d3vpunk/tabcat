import AppKit

/// The wordmark, drawn small in the launcher's bottom corner.
///
/// Two files rather than one tinted template image. The mark is two-tone by design —
/// a near-black "tab" against a purple "cat" — and a template throws the colour away,
/// which is the one thing that makes it this logo rather than any logo. Near-black is
/// invisible on the dark glass, so the dark-appearance file has that half lightened and
/// the purple left untouched.
///
/// Loaded once each. A `body` runs on every keystroke, and reading a file there would
/// put disk access on the typing path.
enum Branding {
    static let onLight = load("logo-text")
    static let onDark = load("logo-text-on-dark")

    /// Nil when the resource bundle did not come along — a bundled app that was
    /// assembled without it should lose its logo, not its launcher.
    static func wordmark(dark: Bool) -> NSImage? { dark ? onDark : onLight }

    private static func load(_ name: String) -> NSImage? {
        guard let url = Bundle.module.url(forResource: name, withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }
}
