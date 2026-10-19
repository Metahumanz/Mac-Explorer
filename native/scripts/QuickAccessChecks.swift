import Foundation

@main
enum QuickAccessChecks {
  static func main() throws {
    let name = "native-places-checks.\(UUID().uuidString)"
    guard let defaults = UserDefaults(suiteName: name) else { fatalError("No test defaults") }
    defer { defaults.removePersistentDomain(forName: name) }
    let base = ["/Applications", "/Desktop", "/Downloads", "/Documents"]
    var state = QuickAccessState(defaults: defaults), count = 0
    func check(_ value: @autoclosure () -> Bool, _ description: String) throws {
      guard value() else { throw NSError(domain: "QuickAccessChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: description]) }; count += 1
    }
    try check(state.visible(defaultPaths: base) == base, "Default order preserved")
    state.toggle("/Downloads", defaultPaths: base)
    try check(state.visible(defaultPaths: base) == ["/Applications", "/Desktop", "/Documents"], "Default folder can be unpinned")
    state.toggle("/Projects", defaultPaths: base)
    state.toggle("/Projects", defaultPaths: base)
    try check(state.visible(defaultPaths: base) == ["/Applications", "/Desktop", "/Documents"], "Custom pin toggles without duplication")
    state.insert(["/Documents"], at: 0, defaultPaths: base)
    try check(state.visible(defaultPaths: base) == ["/Documents", "/Applications", "/Desktop"], "Move default before first")
    state.insert(["/Documents"], at: 3, defaultPaths: base)
    try check(state.visible(defaultPaths: base) == ["/Applications", "/Desktop", "/Documents"], "Move first below last accounts for removal")
    state.insert(["/Desktop"], at: 2, defaultPaths: base)
    try check(state.visible(defaultPaths: base) == ["/Applications", "/Desktop", "/Documents"], "Drop immediately after itself is no-op")
    state.insert(["/Downloads", "/Projects", "/Projects"], at: 1, defaultPaths: base)
    try check(state.visible(defaultPaths: base) == ["/Applications", "/Downloads", "/Projects", "/Desktop", "/Documents"], "Multi-folder insertion restores unpinned defaults and deduplicates")
    try check(state.customPaths == ["/Projects"], "Defaults never become custom duplicates")
    state.save(to: defaults)
    var restored = QuickAccessState(defaults: defaults)
    try check(restored.visible(defaultPaths: base) == state.visible(defaultPaths: base), "Order survives new instance")
    restored.toggle("/Downloads", defaultPaths: base); restored.save(to: defaults)
    try check(!QuickAccessState(defaults: defaults).visible(defaultPaths: base).contains("/Downloads"), "Default exclusion persists")
    restored.toggle("/Downloads", defaultPaths: base)
    try check(restored.visible(defaultPaths: base).last == "/Downloads", "Repinning starts at end of custom order")
    restored.insert(["/Desktop", "/Projects"], at: 0, defaultPaths: base)
    try check(Array(restored.visible(defaultPaths: base).prefix(2)) == ["/Desktop", "/Projects"], "Existing multi-pin reorder retains source order")
    restored.insert(["relative", "\u{0}", "/Valid"], at: -5, defaultPaths: base)
    try check(restored.visible(defaultPaths: base).first == "/Valid", "Bad persisted paths rejected and negative insertion clamped")
    restored.insert(["/Last"], at: 100, defaultPaths: base)
    try check(restored.visible(defaultPaths: base).last == "/Last", "Out-of-range insertion clamped")
    defaults.set(["/Desktop", "/Desktop", "relative", "/Legacy"], forKey: "pins")
    defaults.set(["/Desktop", "/Desktop", "/Gone"], forKey: "placeOrder")
    let legacy = QuickAccessState(defaults: defaults)
    try check(legacy.visible(defaultPaths: base).filter { $0 == "/Desktop" }.count == 1, "Legacy pins deduplicate defaults")
    try check(!legacy.visible(defaultPaths: base).contains("/Gone"), "Stale ordering entries do not become pins")
    print("QuickAccessChecks: \(count) assertions passed.")
  }
}
