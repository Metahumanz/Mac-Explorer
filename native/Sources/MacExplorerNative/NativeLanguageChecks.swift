import AppKit
import ExplorerCore

@MainActor
enum NativeLanguageChecks {
  static func run() async throws -> [String] {
    let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent("native-language-\(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: false)
    let suite = "native-language.\(UUID().uuidString)", defaults = UserDefaults(suiteName: suite)!
    defaults.set(false, forKey: "versionControl")
    let mode = NativeLanguage.mode, menu = NSApp.mainMenu, windowsMenu = NSApp.windowsMenu, key = NSApp.keyWindow
    let delegate = ApplicationDelegate(), fixture = BrowserController(initial: root, defaults: defaults)
    fixture.home = root; fixture.testTrashDirectory = root.appendingPathComponent("trash"); fixture.filePasteboard = NSPasteboard(name: .init(suite))
    let first = delegate.createWindow(tab: BrowserTab(history: [root]), source: fixture, at: NSPoint(x: 200, y: 800))
    let second = delegate.createWindow(tab: BrowserTab(history: [root]), source: fixture, at: NSPoint(x: 240, y: 800))
    defer {
      for window in delegate.browserWindows { ExplorerDialogs.close(in: window); window.close() }
      fixture.stopObserving(); fixture.filePasteboard.releaseGlobally(); defaults.removePersistentDomain(forName: suite); try? fm.removeItem(at: root)
      NativeLanguage.mode = mode; NSApp.mainMenu = menu; NSApp.windowsMenu = windowsMenu; key?.makeKeyAndOrderFront(nil)
    }
    var checks: [String] = []
    for language in ["en", "zh-TW", "zh-CN"] {
      guard let old = first.contentViewController as? BrowserController else { throw NativeSmoke.Failure(description: "Language fixture missing") }
      old.openTab(at: root); let count = old.tabs.count
      old.executeAction("settings"); old.changeLanguage(language)
      let deadline = Date().addingTimeInterval(8)
      while first.contentViewController === old, Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
      guard let a = first.contentViewController as? BrowserController, let b = second.contentViewController as? BrowserController,
        a !== old, a.newButton.title == NL("新建"), b.newButton.title == a.newButton.title,
        a.tabs.count == count, a.directory.path == root.path, defaults.string(forKey: "language") == language,
        ExplorerDialogs.isPresenting(in: first) else { throw NativeSmoke.Failure(description: "Language rebuild did not preserve windows, tabs or settings: \(language)") }
      checks.append("Language \(language) rebuilds both windows and retains tabs, location, preference and settings")
      guard a.table.tableColumns.first(where: { $0.identifier.rawValue == "created" })?.title == NL("创建日期"),
        b.sortMenu().contains(where: { $0.title == NL("创建日期") }) else { throw NativeSmoke.Failure(description: "Created-date localization missing: \(language)") }
      checks.append("Language \(language) localizes the Created column and sort menu")
      let volume = NativeVolume(url: root, name: "Language volume", total: nil, free: nil, kind: .network, canEject: false)
      let card = DriveCard(volume: volume)
      guard card.accessibilityLabel()?.contains(NL("网络驱动器")) == true, card.accessibilityLabel()?.contains(NL("容量未知")) == true else { throw NativeSmoke.Failure(description: "Volume localization missing: \(language)") }
      checks.append("Language \(language) localizes network drive type and unknown capacity")
    }
    return checks
  }
}
