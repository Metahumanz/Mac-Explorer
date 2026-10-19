import AppKit
import ExplorerCore

@MainActor
enum NativePrivacyChecks {
  static func run() async throws -> [String] {
    let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent("native-privacy-\(UUID().uuidString)"), suite = "native-privacy.\(UUID().uuidString)"
    let denied = root.appendingPathComponent("denied")
    try fm.createDirectory(at: denied, withIntermediateDirectories: true)
    try fm.setAttributes([.posixPermissions: 0], ofItemAtPath: denied.path)
    let defaults = UserDefaults(suiteName: suite)!, browser = BrowserController(initial: denied, defaults: UserDefaults(suiteName: suite)!)
    browser.filePasteboard = NSPasteboard(name: .init(suite))
    let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 980, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentViewController = browser
    defer { browser.stopObserving(); window.close(); browser.filePasteboard.releaseGlobally(); defaults.removePersistentDomain(forName: suite); try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: denied.path); try? fm.removeItem(at: root) }
    browser.reload(); try await until { !browser.loading }
    guard browser.lastError != nil, !browser.privacySettings.isHidden else { throw NativeSmoke.Failure(description: "Permission errors must expose their Settings recovery action") }
    browser.errorClose.performClick(nil)
    guard browser.privacySettings.isHidden else { throw NativeSmoke.Failure(description: "Dismissing a permission error hides its recovery action") }
    browser.navigate(to: root); try await until { !browser.loading }
    guard browser.lastError == nil, browser.privacySettings.isHidden else { throw NativeSmoke.Failure(description: "Permission recovery does not remain on accessible folders") }
    return ["Denied directory exposes Settings recovery", "Dismissing the error clears Settings recovery", "Accessible navigation clears permission recovery"]
  }
  private static func until(_ predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(8)
    while !predicate(), Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
    guard predicate() else { throw NativeSmoke.Failure(description: "Permission UI check timed out") }
  }
}
