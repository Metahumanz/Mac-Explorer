import AppKit
import ExplorerCore

@MainActor
enum NativeSMBChecks {
  private static func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
  private static func texts(_ view: NSView) -> [String] { descendants(view).compactMap { ($0 as? NSTextField)?.stringValue } }
  private static func children(_ window: NSWindow) -> [NSWindow] { (window.childWindows ?? []).flatMap { [$0] + children($0) } }
  private static func until(_ predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(10)
    while !predicate() { guard Date() < deadline else { throw NativeSmoke.Failure(description: "SMB workflow check timed out") }; try await Task.sleep(nanoseconds: 20_000_000) }
  }
  private static func clickMenu(_ title: String, owner: NSWindow) throws {
    guard let row = children(owner).compactMap(\.contentView).flatMap(descendants).first(where: { $0.accessibilityRole() == .menuItem && $0.accessibilityLabel() == title }), let window = row.window,
      let event = NSEvent.mouseEvent(with: .leftMouseUp, location: row.convert(NSPoint(x: 20, y: 16), to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 0) else { throw NativeSmoke.Failure(description: "Missing SMB menu: " + title) }
    row.mouseUp(with: event)
  }
  private static func capture(_ window: NSWindow, to url: URL) throws {
    guard let view = window.contentView else { throw NativeSmoke.Failure(description: "Missing SMB view") }; view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw NativeSmoke.Failure(description: "No SMB screenshot") }; view.cacheDisplay(in: view.bounds, to: bitmap)
    guard let data = bitmap.representation(using: .png, properties: [:]) else { throw NativeSmoke.Failure(description: "Cannot encode SMB screenshot") }; try data.write(to: url)
  }
  static func run(output: URL) async throws -> [String] {
    let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent("native-smb-workflow-" + UUID().uuidString)
    let target = root.appendingPathComponent("Actual mounted name 7"), file = root.appendingPathComponent("keep.txt")
    try fm.createDirectory(at: target, withIntermediateDirectories: true); try Data("retain source".utf8).write(to: file)
    let suite = "local.macexplorer.native-smb-workflow." + UUID().uuidString, defaults = UserDefaults(suiteName: suite)!
    defaults.set(false, forKey: "versionControl"); let store = SavedSMBConnections(defaults: defaults)
    enum Outcome { case success, denied, cancelled, timeout, pending }
    var outcome = Outcome.success, calls = 0, inputs: [String] = [], pending: CheckedContinuation<URL?, Error>?
    var identity = "mount-1"
    let session = SMBConnectionSession(mountEvidence: { _ in .mounted(identity) }, connection: { address in
      calls += 1; inputs.append(address)
      switch outcome {
      case .success: return target
      case .denied: throw NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES))
      case .cancelled: return nil
      case .timeout: throw NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
      case .pending: return try await withCheckedThrowingContinuation { pending = $0 }
      }
    })
    var snapshot: [NativeVolume] = []
    let view = ExplorerSpecialView(volumeLoader: { snapshot }, discoveryEnabled: false, defaults: defaults, connectionSession: session)
    let second = ExplorerSpecialView(volumeLoader: { snapshot }, discoveryEnabled: false, defaults: defaults, connectionSession: session)
    let oldKey = NSApp.keyWindow, oldAppearance = NSApp.appearance
    var windows: [NSWindow] = [], browser: BrowserController?
    func makeWindow(_ view: NSView) -> NSWindow {
      let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 960, height: 760), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false; window.contentView = view; window.makeKeyAndOrderFront(nil); windows.append(window); return window
    }
    let window = makeWindow(view); _ = makeWindow(second)
    let board = NSPasteboard(name: .init(suite))
    defer {
      pending?.resume(returning: nil); pending = nil; session.cancel(); browser?.stopObserving()
      ExplorerMenu.dismiss(); for window in windows { ExplorerDialogs.close(in: window); window.close() }
      board.releaseGlobally(); defaults.removePersistentDomain(forName: suite); defaults.synchronize(); try? fm.removeItem(at: root)
      NSApp.appearance = oldAppearance; oldKey?.makeKeyAndOrderFront(nil)
    }
    var checks: [String] = []
    func check(_ condition: Bool, _ title: String) throws { guard condition else { throw NativeSmoke.Failure(description: title) }; checks.append(title); print("PASS SMB: " + title) }
    func rows(_ view: NSView) -> [SavedConnectionRow] { descendants(view).compactMap { $0 as? SavedConnectionRow } }
    view.show("network"); second.show("network")
    try await Task.sleep(nanoseconds: 100_000_000)
    try check(calls == 0 && rows(view).isEmpty, "Network view startup does not connect or persist an empty favorite list")
    guard let add = descendants(view).compactMap({ $0 as? EDButton }).first(where: { $0.title == NL("添加连接") }) else { throw NativeSmoke.Failure(description: "Missing Add connection") }
    add.onPress?(); try await until { ExplorerDialogs.isPresenting(in: window) }
    func formField(_ title: String) throws -> NSTextField {
      guard let field = children(window).compactMap(\.contentView).flatMap(descendants).compactMap({ $0 as? NSTextField }).first(where: { $0.isEditable && $0.accessibilityLabel() == title }) else { throw NativeSmoke.Failure(description: "Missing SMB form field: " + title) }; return field
    }
    func saveButton() throws -> EDButton {
      guard let button = children(window).compactMap(\.contentView).flatMap(descendants).compactMap({ $0 as? EDButton }).first(where: { $0.title == NL("保存") }) else { throw NativeSmoke.Failure(description: "Missing Save connection") }; return button
    }
    let name = try formField(NL("名称")), address = try formField(NL("服务器地址"))
    try check(try !saveButton().isEnabled, "Empty SMB form cannot be saved")
    name.stringValue = "团队资料"; address.stringValue = "SMB://FIXTURE:445/团队 文件/"
    address.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: address))
    try check(try saveButton().isEnabled, "Valid name and credential-free address enable Save")
    try saveButton().onPress?()
    try await until { !ExplorerDialogs.isPresenting(in: window) && rows(view).count == 1 && rows(second).count == 1 }
    let saved = store.list()[0]
    try check(saved.address == "smb://fixture/%E5%9B%A2%E9%98%9F%20%E6%96%87%E4%BB%B6" && calls == 0, "Saving normalizes the address without connecting")
    try check(rows(second)[0].item == saved, "Favorites synchronize into another open window")
    rows(view)[0].more.onPress?(); try clickMenu(NL("编辑连接"), owner: window)
    try await until { ExplorerDialogs.isPresenting(in: window) }
    let rename = try formField(NL("名称")); rename.stringValue = "团队资料（常用）"; rename.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: rename)); try saveButton().onPress?()
    try await until { rows(second).first?.item.name == "团队资料（常用）" }
    try check(store.list()[0].id == saved.id && calls == 0, "Editing keeps identity and does not mount a share")
    // Duplicate validation is visible and leaves the dialog open.
    add.onPress?(); try await until { ExplorerDialogs.isPresenting(in: window) }
    let duplicateName = try formField(NL("名称")), duplicateAddress = try formField(NL("服务器地址"))
    duplicateName.stringValue = "Duplicate"; duplicateAddress.stringValue = saved.address; duplicateAddress.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: duplicateAddress)); try saveButton().onPress?()
    try check(ExplorerDialogs.isPresenting(in: window) && children(window).compactMap(\.contentView).flatMap(texts).contains(NL("该连接已在常用连接中。")) && store.list().count == 1, "Duplicate favorite reports an inline error without overwriting")
    ExplorerDialogs.close(in: window)
    NSApp.appearance = NSAppearance(named: .aqua); try capture(window, to: output.appendingPathComponent("native-smb-favorites-light.png"))
    NSApp.appearance = NSAppearance(named: .darkAqua); window.setContentSize(NSSize(width: 480, height: 760)); try capture(window, to: output.appendingPathComponent("native-smb-favorites-compact-dark.png"))
    NSApp.appearance = oldAppearance; window.setContentSize(NSSize(width: 960, height: 760))

    var navigations: [URL] = []; view.onNavigate = { navigations.append($0) }
    outcome = .pending; rows(view)[0].onConnect?()
    try await until { pending != nil && texts(second).contains(NL("正在连接…")) }
    try check(calls == 1 && session.isBusy && rows(second).allSatisfy { !$0.connect.isEnabled }, "A single shared attempt disables duplicate connections in both windows")
    do { try session.begin("smb://fixture/another", owner: UUID()) { _ in }; throw NativeSmoke.Failure(description: "Duplicate attempt accepted") } catch is NativeSmoke.Failure { throw NativeSmoke.Failure(description: "Duplicate attempt accepted") } catch { try check(calls == 1, "Duplicate attempt is rejected before starting another service call") }
    guard let cancel = descendants(view).compactMap({ $0 as? EDButton }).first(where: { $0.title == NL("取消") }) else { throw NativeSmoke.Failure(description: "Missing shared cancel") }
    cancel.onPress?()
    try check(session.phase == .cancelling && session.isBusy, "Cancellation stays pending until the injected system completes")
    snapshot = [NativeVolume(url: target, name: "Different mount name", total: 100, free: 50, kind: .network, canEject: true)]
    pending?.resume(returning: target); pending = nil
    try await until { !session.isBusy && texts(view).contains(NL("已挂载")) }
    try check(session.phase == .connected && navigations.isEmpty && session.connectedPaths[saved.address] == target, "Failed cancellation records the actual mount but does not navigate or falsely report cancelled")
    outcome = .success; rows(view)[0].onConnect?()
    try await until { !session.isBusy && navigations == [target] }
    try check(inputs.last == saved.address && calls == 2 && target.lastPathComponent != "团队 文件", "Open revalidates through the service and navigates its real returned path")
    session.refreshMountProofs()
    try check(session.connectedPaths[saved.address] == target, "Late notification for the same mount preserves its verified association")
    identity = "mount-2"; session.refreshMountProofs()
    try check(session.connectedPaths[saved.address] == nil && !session.missingAddresses.contains(saved.address), "A different mount at the same path becomes unverified without navigating to it")
    rows(view)[0].onConnect?(); try await until { !session.isBusy && navigations.count == 2 }
    snapshot = []; view.show("network")
    try await until { texts(view).contains(NL("未挂载")) }
    try check(rows(view)[0].connect.title == NL("重新连接") && session.phase == .idle && !texts(view).contains(NL("已连接")), "Missing verified mount offers an explicit reconnect")
    outcome = .denied; rows(view)[0].onConnect?()
    try await until { !session.isBusy && texts(view).contains(NL("连接失败")) }
    try check(navigations == [target, target] && rows(view)[0].connect.isEnabled, "Permission failure leaves navigation unchanged and permits manual retry")
    outcome = .timeout; rows(view)[0].onConnect?(); try await until { !session.isBusy && session.message == NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut).localizedDescription }
    try check(navigations == [target, target], "Timeout reports failure without automatic retries or navigation")
    outcome = .cancelled; rows(view)[0].onConnect?(); try await until { !session.isBusy && session.phase == .cancelled }
    try check(navigations == [target, target], "Authentication cancellation leaves the current location untouched")
    outcome = .pending; rows(view)[0].onConnect?(); try await until { pending != nil }
    snapshot = [NativeVolume(url: target, name: "Actual mount", total: 100, free: 50, kind: .network, canEject: true)]
    view.show("computer"); pending?.resume(returning: target); pending = nil
    try await until { !session.isBusy }
    try check(navigations == [target, target] && session.phase == .connected, "Late mount success after leaving the network page cannot hijack navigation")
    view.show("network"); try await until { !rows(view).isEmpty }
    snapshot = [NativeVolume(url: target, name: "Offline", total: nil, free: nil, kind: .network, canEject: true, metadataUnavailable: true)]
    view.show("network"); try await until { texts(view).contains(NL("读取失败")) }
    try check(rows(view)[0].connect.title == NL("重新连接"), "Known mount with unreadable metadata is distinct from a missing mount")
    snapshot = [NativeVolume(url: target, name: "Unknown metadata", total: nil, free: nil, kind: .unknown, canEject: false)]
    view.show("network"); try await until { texts(view).contains(NL("读取失败")) }
    try check(session.connectedPaths[saved.address] == target && !session.missingAddresses.contains(saved.address), "Unknown mount classification is a read failure, not proof of unmounting")
    session.invalidateMounts(); snapshot = []; view.show("network"); try await until { texts(view).contains(NL("待连接")) }
    try check(session.connectedPaths.isEmpty, "Wake or uncertain remount invalidates remembered paths without guessing a share identity")

    // The address-bar entry point shares the service without disturbing a failed cut.
    outcome = .denied
    let controller = BrowserController(initial: root, defaults: defaults, networkSession: session); browser = controller
    controller.home = root; controller.filePasteboard = board
    let browserWindow = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1180, height: 780), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    browserWindow.isReleasedWhenClosed = false; browserWindow.contentViewController = controller; browserWindow.makeKeyAndOrderFront(nil); windows.append(browserWindow)
    try await until { !controller.loading && controller.entries.contains { $0.url == file } }
    controller.selectedPaths = [file.path]; controller.executeAction("cut")
    let count = board.changeCount, selection = controller.selectedPaths
    controller.address.stringValue = saved.address; controller.goAddress()
    try await until { !session.isBusy && !controller.errorLabel.stringValue.isEmpty }
    try check(controller.directory == root && controller.selectedPaths == selection && board.changeCount == count && fm.fileExists(atPath: file.path), "Address-bar connection failure preserves tab, selection, cut clipboard and source")
    outcome = .pending; controller.address.stringValue = saved.address; controller.goAddress(); try await until { pending != nil }
    controller.navigate(to: target)
    let navigatedTarget = target.standardizedFileURL
    try check(controller.directory == navigatedTarget, "Subsequent navigation reaches the standardized fixture directory before connection completion")
    pending?.resume(returning: root); pending = nil
    try await until { !session.isBusy && !controller.loading }
    try check(controller.directory == navigatedTarget && board.changeCount == count && fm.fileExists(atPath: file.path) && !fm.fileExists(atPath: target.appendingPathComponent(file.lastPathComponent).path), "Late address-bar success cannot override subsequent navigation or replay the cut")
    rows(view)[0].more.onPress?(); try clickMenu(NL("移除连接"), owner: window)
    try await until { rows(view).isEmpty && rows(second).isEmpty }
    try check(store.list().isEmpty && fm.fileExists(atPath: target.path), "Removing a favorite synchronizes windows without unmounting or deleting data")
    _ = try store.save(name: "Restart fixture", address: saved.address); defaults.synchronize()
    try await verifyRelaunch(root: root, suite: suite, output: output)
    try check(true, "Fresh process restores favorites without restoring paths or starting a connection")
    try check(try Data(contentsOf: file) == Data("retain source".utf8), "All connection outcomes preserve fixture file content")
    return checks
  }
  private static func verifyRelaunch(root: URL, suite: String, output: URL) async throws {
    let process = Process(); process.executableURL = Bundle.main.executableURL
    let report = output.appendingPathComponent("saved-smb-relaunch.json"), log = output.appendingPathComponent("saved-smb-relaunch.log")
    process.arguments = ["--smoke-test", root.path, "--report", report.path, "--saved-smb-settings", suite]
    FileManager.default.createFile(atPath: log.path, contents: nil); let handle = try FileHandle(forWritingTo: log); defer { try? handle.close() }
    process.standardOutput = handle; process.standardError = handle; try process.run(); defer { if process.isRunning { process.terminate() } }
    try await until { !process.isRunning }
    guard process.terminationStatus == 0, let data = try JSONSerialization.jsonObject(with: Data(contentsOf: report)) as? [String: Any], data["passed"] as? Bool == true else { throw NativeSmoke.Failure(description: "Saved SMB relaunch failed") }
  }
  static func restore(root: URL, suite: String, window: NSWindow) async throws -> [String] {
    let prefix = "local.macexplorer.native-smb-workflow."
    guard suite.hasPrefix(prefix), UUID(uuidString: String(suite.dropFirst(prefix.count))) != nil, root.lastPathComponent.hasPrefix("native-smb-workflow-"), let defaults = UserDefaults(suiteName: suite) else { throw NativeSmoke.Failure(description: "Invalid SMB relaunch fixture") }
    let session = SMBConnectionSession(connection: { _ in throw NativeSmoke.Failure(description: "Restoring favorites must not connect") })
    let view = ExplorerSpecialView(volumeLoader: { [] }, discoveryEnabled: false, defaults: defaults, connectionSession: session)
    (window.contentViewController as? BrowserController)?.stopObserving(); window.contentViewController = nil; window.contentView = view; view.show("network")
    try await until { descendants(view).contains { $0 is SavedConnectionRow } }
    guard SavedSMBConnections(defaults: defaults).list().count == 1, session.phase == .idle, session.connectedPaths.isEmpty, texts(view).contains(NL("待连接")) else { throw NativeSmoke.Failure(description: "Saved SMB preference restore mismatch") }
    return ["Saved name and validated address survived process restart", "No automatic connection or stale persisted mount path"]
  }
}
