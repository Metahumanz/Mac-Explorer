import AppKit
import ExplorerCore

@MainActor
enum NativeVCSUIChecks {
  static func run(parent: NSWindow) async throws -> [String] {
    let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent("native-vcs-ui-\(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: false)
    defer { try? fm.removeItem(at: root) }
    let service = NativeVersionControl(backupDirectory: root.appendingPathComponent("backups"))
    defer { service.setEnabled(false) }
    var checks: [String] = [], callbacks = 0
    var owned: [NSWindow] = []
    defer { for window in owned { window.close() }; parent.makeKeyAndOrderFront(nil) }
    func expect(_ value: Bool, _ message: String) throws { guard value else { throw NativeSmoke.Failure(description: message) }; checks.append(message) }
    func write(_ url: URL, _ value: String) throws { try Data(value.utf8).write(to: url) }
    func read(_ url: URL) throws -> String { try String(contentsOf: url, encoding: .utf8) }
    func command(_ executable: String, _ arguments: [String], at directory: URL) async throws -> String {
      try await Task.detached(priority: .userInitiated) {
        try NativeCommand.run(executable: executable, arguments: arguments, directory: directory,
          environment: ["GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"], timeout: 30).text
      }.value
    }
    func git(_ directory: URL, _ arguments: String...) async throws -> String { try await command("/usr/bin/git", ["-c", "commit.gpgSign=false"] + arguments, at: directory) }
    func configure(_ directory: URL) async throws {
      for (key, value) in [("user.name", "Native UI Fixture"), ("user.email", "fixture@example.invalid"), ("core.hooksPath", "/dev/null"), ("commit.gpgSign", "false")] { _ = try await git(directory, "config", key, value) }
    }
    func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    func views(_ window: NSWindow) -> [NSView] { window.contentView.map(descendants) ?? [] }
    func button(_ window: NSWindow, _ selector: String) throws -> NSButton {
      guard let value = views(window).compactMap({ $0 as? NSButton }).first(where: { $0.action == NSSelectorFromString(selector) && $0.target is NativeVCSWindow }) else { throw NativeSmoke.Failure(description: "Missing VCS action: \(selector)") }; return value
    }
    func output(_ window: NSWindow) throws -> NSTextView {
      guard let value = views(window).compactMap({ $0 as? NSTextView }).first(where: { !$0.isEditable }) else { throw NativeSmoke.Failure(description: "Missing VCS output") }; return value
    }
    func present(_ directory: URL, _ paths: [URL], _ action: NativeVCSAction) async throws -> NSWindow {
      let previous = Set((parent.childWindows ?? []).map(ObjectIdentifier.init))
      NativeVCSWindow.present(service: service, directory: directory, paths: paths, action: action, parent: parent) { callbacks += 1 }
      guard let window = parent.childWindows?.first(where: { !previous.contains(ObjectIdentifier($0)) }) else { throw NativeSmoke.Failure(description: "VCS presentation creates a native child window") }
      owned.append(window)
      if action == .diff { try await until { (try? output(window).string.isEmpty) == false } }
      else { try await until { (try? button(window, "execute").isHidden) == false } }
      return window
    }
    func execute(_ window: NSWindow) async throws {
      let previous = callbacks
      try button(window, "execute").performClick(nil)
      try await until { callbacks == previous + 1 }
      try expect(try button(window, "execute").isHidden && button(window, "dismiss").isEnabled, "VCS completion refreshes the caller and re-enables window dismissal")
    }
    let repository = root.appendingPathComponent("git")
    try fm.createDirectory(at: repository, withIntermediateDirectories: false)
    _ = try await git(repository, "init", "-b", "main"); try await configure(repository)
    let tracked = repository.appendingPathComponent("tracked.txt"), added = repository.appendingPathComponent("new file.txt")
    try write(tracked, "original\n"); _ = try await git(repository, "add", "."); _ = try await git(repository, "commit", "-m", "initial")
    let head = try await git(repository, "rev-parse", "HEAD")
    try write(tracked, "staged-value\n"); _ = try await git(repository, "add", "tracked.txt"); try write(tracked, "unstaged-value\n"); try write(added, "new preserved\n")
    let diff = try await present(repository, [tracked], .diff)
    guard let tabs = views(diff).compactMap({ $0 as? NSSegmentedControl }).first else { throw NativeSmoke.Failure(description: "Git diff has staged and unstaged controls") }
    try expect(!tabs.isHidden && (try output(diff)).string.contains("+unstaged-value"), "Git diff window initially previews unstaged content")
    tabs.selectedSegment = 1; if let action = tabs.action { tabs.sendAction(action, to: tabs.target) }
    try expect(try output(diff).string.contains("+staged-value") && !output(diff).string.contains("+unstaged-value"), "Git diff segments preview staged content independently")
    try expect(try await git(repository, "rev-parse", "HEAD") == head && read(tracked) == "unstaged-value\n", "Opening and switching Git previews never modifies repository content")
    diff.close()
    let add = try await present(repository, [added], .add)
    try expect(try output(add).string.contains("new file.txt"), "Git add window previews its file manifest")
    try await execute(add); add.close()
    try expect(try await git(repository, "show", ":new file.txt") == "new preserved\n", "Confirming Git add stages the previewed fixture")
    let commit = try await present(repository, [tracked], .commit)
    try expect(try !button(commit, "execute").isEnabled && output(commit).string.contains("new file.txt"), "Git commit previews all staged changes and requires a message")
    guard let message = views(commit).compactMap({ $0 as? NSTextView }).first(where: { $0.isEditable }) else { throw NativeSmoke.Failure(description: "Commit window has a message editor") }
    message.string = "native UI fixture commit"; message.delegate?.textDidChange?(Notification(name: NSText.didChangeNotification, object: message))
    try expect(try button(commit, "execute").isEnabled, "Valid commit text enables the real confirmation button")
    try await execute(commit); commit.close()
    try expect(try await git(repository, "show", "HEAD:tracked.txt") == "staged-value\n" && read(tracked) == "unstaged-value\n", "Git commit window preserves unstaged working bytes")
    let revert = try await present(repository, [tracked], .revert)
    try write(tracked, "changed after preview\n")
    try await execute(revert)
    try expect(try !button(revert, "reload").isHidden && read(tracked) == "changed after preview\n", "Stale VCS confirmation shows retry and preserves the changed file")
    try button(revert, "reload").performClick(nil)
    try await until { (try? button(revert, "execute").isHidden) == false }
    try await execute(revert)
    try expect(try read(tracked) == "staged-value\n" && !button(revert, "revealBackup").isHidden, "VCS retry refreshes the plan and exposes the revert backup")
    let backupFiles = (fm.enumerator(at: root.appendingPathComponent("backups"), includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []).filter { $0.path.hasSuffix("/files/tracked.txt") }
    try expect(try backupFiles.contains(where: { try read($0) == "changed after preview\n" }), "Revert window preserves the exact pre-operation fixture in its backup")
    revert.close()
    let remote = root.appendingPathComponent("remote.git"), peer = root.appendingPathComponent("peer")
    _ = try await git(root, "clone", "--bare", repository.path, remote.path); _ = try await git(repository, "remote", "add", "origin", remote.path)
    _ = try await git(repository, "fetch", "origin"); _ = try await git(repository, "branch", "--set-upstream-to=origin/main")
    _ = try await git(root, "clone", remote.path, peer.path); try await configure(peer)
    try write(peer.appendingPathComponent("from-peer.txt"), "local peer content\n")
    _ = try await git(peer, "add", "."); _ = try await git(peer, "commit", "-m", "peer fixture"); _ = try await git(peer, "push")
    let update = try await present(repository, [repository], .update)
    try expect(!fm.fileExists(atPath: repository.appendingPathComponent("from-peer.txt").path), "Git update preview is read-only")
    try await execute(update); update.close()
    try expect(try read(repository.appendingPathComponent("from-peer.txt")) == "local peer content\n", "Git update window fast-forwards only a disposable local repository")
    if fm.isExecutableFile(atPath: "/opt/homebrew/bin/svn"), fm.isExecutableFile(atPath: "/opt/homebrew/bin/svnadmin") {
      let svnRepository = root.appendingPathComponent("svn-repository"), wc = root.appendingPathComponent("svn-wc"), svnPeer = root.appendingPathComponent("svn-peer")
      let config = root.appendingPathComponent("svn-config"); try fm.createDirectory(at: config, withIntermediateDirectories: false)
      func svn(_ directory: URL, _ arguments: String...) async throws -> String { try await command("/opt/homebrew/bin/svn", ["--non-interactive", "--config-dir", config.path] + arguments, at: directory) }
      _ = try await command("/opt/homebrew/bin/svnadmin", ["create", svnRepository.path], at: root)
      _ = try await svn(root, "checkout", svnRepository.absoluteString, wc.path)
      let file = wc.appendingPathComponent("tracked.txt"), newFile = wc.appendingPathComponent("new.txt")
      try write(file, "svn original\n"); _ = try await svn(wc, "add", "tracked.txt"); _ = try await svn(wc, "commit", "-m", "initial")
      try write(file, "svn changed\n"); try write(newFile, "svn new\n")
      let svnDiff = try await present(wc, [file], .diff)
      try expect(try output(svnDiff).string.contains("+svn changed") && views(svnDiff).compactMap { $0 as? NSSegmentedControl }.allSatisfy(\.isHidden), "SVN diff uses the working-copy preview without Git staging tabs")
      svnDiff.close()
      let svnAdd = try await present(wc, [newFile], .add); try await execute(svnAdd); svnAdd.close()
      let svnCommit = try await present(wc, [newFile], .commit)
      guard let message = views(svnCommit).compactMap({ $0 as? NSTextView }).first(where: { $0.isEditable }) else { throw NativeSmoke.Failure(description: "SVN commit has a message editor") }
      message.string = "svn UI fixture commit"; message.delegate?.textDidChange?(Notification(name: NSText.didChangeNotification, object: message))
      try await execute(svnCommit); svnCommit.close()
      let svnStatus = try await Task.detached { try service.status(directory: wc, force: true) }.value
      try expect(svnStatus?.statesByPath[newFile.standardizedFileURL.path] == .clean, "SVN add and commit confirmations refresh status to clean")
      let svnRevert = try await present(wc, [file], .revert); try await execute(svnRevert); svnRevert.close()
      try expect(try read(file) == "svn original\n", "SVN revert window restores only its temporary tracked fixture")
      _ = try await svn(root, "checkout", svnRepository.absoluteString, svnPeer.path)
      try write(svnPeer.appendingPathComponent("from-peer.txt"), "svn local peer\n"); _ = try await svn(svnPeer, "add", "from-peer.txt"); _ = try await svn(svnPeer, "commit", "-m", "peer")
      let svnUpdate = try await present(wc, [wc], .update); try await execute(svnUpdate); svnUpdate.close()
      try expect(try read(wc.appendingPathComponent("from-peer.txt")) == "svn local peer\n", "SVN update window refreshes from its disposable local repository")
    } else { checks.append("SKIP SVN UI: svn and svnadmin are not installed") }
    return checks
  }
  private static func until(_ predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(15)
    while !predicate() { guard Date() < deadline else { throw NativeSmoke.Failure(description: "VCS UI check timed out") }; try await Task.sleep(nanoseconds: 20_000_000) }
  }
}

@MainActor
enum NativePaneChecks {
  static func run() async throws -> [String] {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("native-pane-\(UUID().uuidString)"), suite = "NativePaneChecks.\(UUID().uuidString)"
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    guard let defaults = UserDefaults(suiteName: suite) else { throw NativeSmoke.Failure(description: "No pane fixture preferences") }
    defaults.set(["view": "details", "iconSize": 64, "sort": "name", "ascending": true], forKey: "defaultFolderView")
    let first = BrowserController(initial: root, defaults: defaults), second = BrowserController(initial: root, defaults: defaults)
    first.home = root; second.home = root
    let originalMenu = NSApp.mainMenu
    let windows = [first, second].map { controller -> NSWindow in
      let window = NSWindow(contentRect: NSRect(x: 60, y: 80, width: 980, height: 640), styleMask: [.titled, .closable], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false; window.contentViewController = controller; window.orderFront(nil); return window
    }
    defer { first.stopObserving(); second.stopObserving(); windows.forEach { $0.close() }; NSApp.mainMenu = originalMenu; defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: root) }
    first.reload(); second.reload()
    try await until { !first.loading && !second.loading }
    var checks: [String] = []
    func expect(_ value: Bool, _ message: String) throws { guard value else { throw NativeSmoke.Failure(description: message) }; checks.append(message) }
    first.executeAction("preview"); NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: defaults)
    try await until { first.paneMode == "preview" && second.paneMode == "preview" }
    windows.forEach { $0.contentView?.layoutSubtreeIfNeeded() }
    try expect(!first.pane.isHidden && !second.pane.isHidden && first.previewButton.active && second.previewButton.active, "Preview pane preference synchronizes real windows and toolbar state")
    let restored = BrowserController(initial: root, defaults: defaults)
    try expect(restored.paneMode == "preview", "A new browser restores the saved preview pane")
    restored.stopObserving()
    second.executeAction("details-pane"); NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: defaults)
    try await until { first.paneMode == "details" && second.paneMode == "details" }
    windows.forEach { $0.contentView?.layoutSubtreeIfNeeded() }
    try expect(!first.previewButton.active && !second.previewButton.active && defaults.string(forKey: "paneMode") == "details", "Details pane replaces preview across windows and persists")
    guard let close = second.pane.subviews.first(where: { $0.identifier?.rawValue == "close" }) as? ExplorerButton else { throw NativeSmoke.Failure(description: "Pane close button is available") }
    close.performClick(nil); NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: defaults)
    try await until { first.paneMode.isEmpty && second.paneMode.isEmpty }
    windows.forEach { $0.contentView?.layoutSubtreeIfNeeded() }
    try expect(first.pane.isHidden && second.pane.isHidden && defaults.string(forKey: "paneMode") == "", "Closing a pane persists and synchronizes its hidden state")
    return checks
  }
  private static func until(_ predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(10)
    while !predicate() { guard Date() < deadline else { throw NativeSmoke.Failure(description: "Pane check timed out") }; try await Task.sleep(nanoseconds: 20_000_000) }
  }
}
