import AppKit
import ExplorerCore

@MainActor
enum NativePrivacyChecks {
  static func run(output: URL? = nil) async throws -> [String] {
    let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent("native-privacy-\(UUID().uuidString)"), suite = "native-privacy.\(UUID().uuidString)"
    let denied = root.appendingPathComponent("denied"), source = root.appendingPathComponent("keep.txt")
    try fm.createDirectory(at: denied, withIntermediateDirectories: true); try Data("preserve".utf8).write(to: source)
    try fm.setAttributes([.posixPermissions: 0], ofItemAtPath: denied.path)
    let defaults = UserDefaults(suiteName: suite)!
    defaults.set(false, forKey: "versionControl"); defaults.set(true, forKey: "skipTrashConfirmation")
    let browser = BrowserController(initial: denied, defaults: defaults)
    browser.home = root; browser.filePasteboard = NSPasteboard(name: .init(suite))
    let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 1100, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentViewController = browser
    defer { browser.stopObserving(); window.close(); browser.filePasteboard.releaseGlobally(); defaults.removePersistentDomain(forName: suite); try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: denied.path); try? fm.removeItem(at: root) }
    var checks: [String] = []
    func check(_ value: Bool, _ title: String) throws { guard value else { throw NativeSmoke.Failure(description: title) }; checks.append(title); print("PASS permission: " + title) }
    browser.reload(); try await until { !browser.loading }
    try check(browser.lastError != nil && !browser.privacySettings.isHidden && browser.lastError?.contains(NL("没有访问此文件夹的权限")) == false, "Local denial offers optional access settings without claiming a privacy diagnosis")
    browser.errorClose.performClick(nil)
    try check(browser.privacySettings.isHidden, "Dismissing a permission error clears the recovery action")
    browser.navigate(to: root); try await until { !browser.loading && browser.entries.contains { $0.url.path == source.path } }
    try check(browser.lastError == nil && browser.privacySettings.isHidden, "Accessible navigation clears permission recovery")

    let failedSidecar = root.appendingPathComponent("share/._keep.txt")
    let posix = NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES), userInfo: [NSFilePathErrorKey: failedSidecar.path])
    let wrapped = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteNoPermissionError, userInfo: [NSUnderlyingErrorKey: posix])
    let remote = NativeFileFailure.describe(wrapped, at: source, networkLocation: { _ in true })
    try check(!remote.offersPrivacySettings && remote.message.contains("EACCES (13)") && remote.message.contains(failedSidecar.path), "Wrapped SMB denial retains the underlying code and actual failing child path")
    try check(remote.message.hasPrefix(NL("共享访问被拒绝，请检查共享权限或服务器限制。（{0}）", "EACCES (13)")), "Shared denial leads with the reason and code before long paths without diagnosing the server configuration")
    let local = NativeFileFailure.describe(NSError(domain: NSPOSIXErrorDomain, code: Int(EPERM)), at: source, networkLocation: { _ in false })
    try check(local.offersPrivacySettings && local.message.contains("EPERM (1)"), "Local EPERM retains its code and an optional access settings route")
    let unknown = NativeFileFailure.describe(posix, at: nil, networkLocation: { _ in nil })
    try check(!unknown.offersPrivacySettings, "Unknown mount classification does not assert a macOS privacy cause")
    let osStatus = NativeFileFailure.describe(NSError(domain: NSOSStatusErrorDomain, code: -5000), at: source, networkLocation: { _ in true })
    try check(!osStatus.offersPrivacySettings && osStatus.message.contains("-5000"), "Shared OSStatus permission failures retain the system code")
    let noContext = NativeFileFailure.describe(NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES)), at: nil)
    try check(!noContext.offersPrivacySettings, "A denial without a path cannot claim local privacy recovery")
    let notCocoa = NSError(domain: "PermissionFixture", code: NSFileReadNoSuchFileError, userInfo: [NSLocalizedDescriptionKey: "preserve original failure"])
    try check(NativeFileFailure.describe(notCocoa, at: source).message == "preserve original failure", "A coincident numeric error code cannot be mistaken for a missing file")
    try check(NativeFileFailure.describe(NSError(domain: NSPOSIXErrorDomain, code: Int(ENOENT)), at: source).message == NL("文件夹不存在"), "POSIX missing-file errors retain the existing concise recovery message")
    try check(NativeFileFailure.networkLocation(root) == false, "Cached mount classification recognizes the local temporary fixture")

    browser.fileErrorNetworkLocation = { _ in true }
    browser.selectedPaths = [source.path]; browser.executeAction("cut")
    let selection = browser.selectedPaths, clipboardVersion = browser.filePasteboard.changeCount
    var calls = 0
    browser.recycleItem = { _, _, _ in calls += 1; throw wrapped }
    browser.executeAction("trash")
    try await until { !browser.busy && !browser.loading && browser.lastError?.contains("EACCES") == true }
    try check(calls == 1 && browser.privacySettings.isHidden && browser.lastError?.contains(failedSidecar.path) == true, "Actual trash entry reports an injected shared denial without the Settings button or automatic retry")
    try check(browser.selectedPaths == selection && browser.filePasteboard.changeCount == clipboardVersion && fm.fileExists(atPath: source.path), "A failed trash operation preserves selection, cut clipboard and source without permanent-delete fallback")
    if let output, let view = window.contentView, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
      view.layoutSubtreeIfNeeded(); view.cacheDisplay(in: view.bounds, to: bitmap)
      if let data = bitmap.representation(using: .png, properties: [:]) { try data.write(to: output.appendingPathComponent("native-shared-permission-error.png")) }
    }
    browser.fileErrorNetworkLocation = { _ in false }; browser.addressBar.onError?(NSError(domain: NSPOSIXErrorDomain, code: Int(EPERM)))
    try check(!browser.privacySettings.isHidden, "A later local failure can still offer optional settings recovery")
    browser.fileErrorNetworkLocation = { _ in true }; browser.addressBar.onError?(wrapped)
    try check(browser.privacySettings.isHidden, "A later shared failure clears stale local privacy recovery")
    browser.addressBar.onError?(NSError(domain: NSPOSIXErrorDomain, code: Int(EIO)))
    try check(browser.privacySettings.isHidden && browser.lastError?.contains("EACCES") == false, "An unrelated I/O error cannot inherit a previous permission diagnosis")
    try check(try Data(contentsOf: source) == Data("preserve".utf8), "All permission checks leave fixture content unchanged")
    return checks
  }
  private static func until(_ predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(8)
    while !predicate(), Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
    guard predicate() else { throw NativeSmoke.Failure(description: "Permission UI check timed out") }
  }
}
