import AppKit
import ExplorerCore

@MainActor
enum NativeClipboardChecks {
  static func run() async throws -> [String] {
    let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent("native-clipboard-\(UUID().uuidString)")
    let source = root.appendingPathComponent("source"), destination = root.appendingPathComponent("destination")
    try fm.createDirectory(at: source, withIntermediateDirectories: true); try fm.createDirectory(at: destination, withIntermediateDirectories: true)
    let suite = "native-clipboard.\(UUID().uuidString)", defaults = UserDefaults(suiteName: suite)!
    let board = NSPasteboard(name: .init(suite)), marker = NSPasteboard.PasteboardType("electron application/osclipboard;format=\"local.macexplorer.files\"")
    let a = source.appendingPathComponent("a.txt"), b = source.appendingPathComponent("b.txt"), c = source.appendingPathComponent("c.txt")
    for file in [a,b,c] { try Data(file.lastPathComponent.utf8).write(to: file) }
    try Data("existing".utf8).write(to: destination.appendingPathComponent("c.txt"))
    let first = BrowserController(initial: source, defaults: defaults), second = BrowserController(initial: destination, defaults: defaults)
    let trash = root.appendingPathComponent("trash"); try fm.createDirectory(at: trash, withIntermediateDirectories: false)
    first.testTrashDirectory = trash; second.testTrashDirectory = trash
    first.filePasteboard = board; second.filePasteboard = board
    let windows = [first,second].map { controller -> NSWindow in
      let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 980, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false; window.contentViewController = controller; return window
    }
    defer { first.stopObserving(); second.stopObserving(); windows.forEach { $0.close() }; board.releaseGlobally(); defaults.removePersistentDomain(forName: suite); try? fm.removeItem(at: root) }
    first.reload(); second.reload()
    try await until { !first.loading && !second.loading }
    var checks: [String] = []
    func expect(_ value: Bool, _ message: String) throws { guard value else { throw NativeSmoke.Failure(description: message) }; checks.append(message) }
    first.selectedPaths = Set([a,b,c].map(\.path)); first.executeAction("cut"); second.executeAction("paste")
    try await until { !second.busy && !second.loading }
    try expect(!fm.fileExists(atPath: a.path) && !fm.fileExists(atPath: b.path) && fm.fileExists(atPath: c.path), "Cut and paste across windows moves successes and retains a collision source")
    try expect(try String(contentsOf: destination.appendingPathComponent("c.txt")) == "existing", "Cross-window cut never overwrites an existing destination")
    let payload = try JSONSerialization.jsonObject(with: board.data(forType: marker)!) as! [String:Any]
    try expect(payload["paths"] as? [String] == [c.path] && payload["cut"] as? Bool == true, "Partial cut retains only failed sources on the shared clipboard")
    second.reload(); try await until { !second.loading }
    try expect(second.lastError != nil, "Paste failures survive a directory reload")
    second.executeAction("undo"); try await until { !second.busy && !second.loading }
    try expect(fm.fileExists(atPath: a.path) && fm.fileExists(atPath: b.path), "Cross-window move undo restores the original sources")
    first.reload(); try await until { !first.loading }
    first.selectedPaths = [a.path]; first.executeAction("copy"); second.executeAction("paste")
    try await until { !second.busy && !second.loading }
    try expect(fm.fileExists(atPath: a.path) && fm.fileExists(atPath: destination.appendingPathComponent("a.txt").path), "Cross-window copy preserves its source")
    board.clearContents(); board.writeObjects([b as NSURL]); second.executeAction("paste")
    try await until { !second.busy && !second.loading }
    try expect(fm.fileExists(atPath: b.path) && fm.fileExists(atPath: destination.appendingPathComponent("b.txt").path), "Finder-style file URLs default to copy")
    second.executeAction("undo"); try await until { !second.busy && !second.loading }
    try expect(!fm.fileExists(atPath: destination.appendingPathComponent("b.txt").path) && (try fm.contentsOfDirectory(atPath: trash.path)).count == 1, "Copy undo uses only the isolated fixture Trash")
    board.clearContents(); board.writeObjects([b as NSURL]); board.setData(try JSONSerialization.data(withJSONObject: ["paths":[a.path],"cut":true]), forType: marker)
    second.executeAction("paste"); try await until { !second.busy && !second.loading }
    try expect(fm.fileExists(atPath: b.path), "A cut marker with mismatched paths cannot turn a copy into a move")
    try expect(try String(contentsOf: c) == "c.txt", "Clipboard operations preserve collision source bytes")
    return checks
  }
  private static func until(_ predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(8)
    while !predicate(), Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
    guard predicate() else { throw NativeSmoke.Failure(description: "Clipboard check timed out") }
  }
}
