import AppKit
import ExplorerCore

/// A window-local transfer dialog; the main interface and its settings stay unchanged.
@MainActor
final class NativeTransferPanel: NSObject, NSWindowDelegate {
  let window: NSPanel
  let label = NSTextField(labelWithString: NL("正在准备…"))
  let progress = NSProgressIndicator()
  let cancel = NSButton(title: NL("取消"), target: nil, action: nil)
  private var finished = false
  private var lastUpdate = Date.distantPast
  var control: FileTransferControl?
  init(parent: NSWindow?) {
    window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 140), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    super.init()
    window.title = NL("传输文件"); window.isReleasedWhenClosed = false; window.delegate = self
    label.frame = NSRect(x: 20, y: 90, width: 400, height: 22); label.lineBreakMode = .byTruncatingMiddle
    progress.frame = NSRect(x: 20, y: 62, width: 400, height: 16); progress.style = .bar; progress.isIndeterminate = true; progress.startAnimation(nil)
    cancel.frame = NSRect(x: 330, y: 16, width: 90, height: 30); cancel.bezelStyle = .rounded; cancel.target = self; cancel.action = #selector(cancelTransfer)
    for view in [label, progress, cancel] { window.contentView?.addSubview(view) }
    if let parent { window.setFrameOrigin(NSPoint(x: parent.frame.midX - 220, y: parent.frame.midY - 70)) } else { window.center() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      guard let self, !self.finished else { return }; self.window.orderFront(nil)
    }
  }
  @objc private func cancelTransfer() { control?.cancel(); cancel.isEnabled = false; label.stringValue = NL("正在取消…") }
  func windowShouldClose(_ sender: NSWindow) -> Bool { if finished { return true }; cancelTransfer(); return false }
  func update(_ value: FileTransferProgress) {
    guard !finished, control?.isCancelled != true else { return }
    let now = Date()
    guard now.timeIntervalSince(lastUpdate) > 0.1 || value.completedBytes >= value.totalBytes else { return }; lastUpdate = now
    label.stringValue = value.source.lastPathComponent; label.toolTip = value.source.path
    progress.isIndeterminate = false; progress.maxValue = Double(max(1, value.totalBytes)); progress.doubleValue = Double(value.completedBytes)
  }
  func close() { finished = true; window.close(); control = nil }
  func problem(_ value: FileTransferProblem, completion: @escaping (FileTransferDecision) -> Void) {
    guard !finished, control?.isCancelled != true else { completion(.cancel); return }
    window.orderFront(nil)
    let alert = NSAlert(); alert.messageText = value.propertyLoss ? NL("无法保留全部文件属性") : NL("操作中断")
    alert.informativeText = value.source.lastPathComponent + "\n" + value.message
    var decisions: [FileTransferDecision] = [.retry]
    alert.addButton(withTitle: NL("重试"))
    if value.propertyLoss {
      alert.informativeText += "\n" + (value.moving ? NL("继续移动将移除来源，部分属性可能丢失。") : NL("继续复制可能丢失部分属性。"))
      alert.addButton(withTitle: value.moving ? NL("仍然移动") : NL("仍然复制")); decisions.append(.continueWithoutProperties)
    } else if value.collision {
      alert.addButton(withTitle: NL("保留两者")); decisions.append(.keepBoth)
    }
    alert.addButton(withTitle: NL("跳过")); decisions.append(.skip)
    alert.addButton(withTitle: NL("取消")); decisions.append(.cancel)
    alert.buttons.last?.keyEquivalent = "\u{1b}"
    alert.beginSheetModal(for: window) { response in
      let index = response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
      completion(decisions.indices.contains(index) ? decisions[index] : .cancel)
    }
  }
}

/// Semaphore only bridges the background file worker to AppKit's asynchronous sheet.
/// The main thread never waits for the worker.
private final class TransferDecisionReply: @unchecked Sendable {
  let semaphore = DispatchSemaphore(value: 0)
  var decision: FileTransferDecision = .cancel
}

extension BrowserController {
  func runTransferOperation(recordUndo: Bool = true, completion: ((FileActionResult) -> Void)? = nil, _ operation: @escaping @Sendable (FileTransferControl) -> FileActionResult) {
    guard !busy else { return }
    let panel = NativeTransferPanel(parent: view.window)
    let smoke = ProcessInfo.processInfo.arguments.contains("--smoke-test")
    let control = FileTransferControl(onProblem: { [weak panel] value in
      // Existing regression fixtures choose Skip; dialog controls have separate UI checks.
      if smoke { return .skip }
      let reply = TransferDecisionReply()
      DispatchQueue.main.async {
        guard let panel else { reply.semaphore.signal(); return }
        panel.problem(value) { choice in reply.decision = choice; reply.semaphore.signal() }
      }
      reply.semaphore.wait(); return reply.decision
    }, onProgress: { [weak panel] value in DispatchQueue.main.async { panel?.update(value) } })
    panel.control = control
    runAsyncOperation(recordUndo: recordUndo, completion: { result in panel.close(); completion?(result) }) {
      await Task.detached { operation(control) }.value
    }
  }
}

@MainActor
enum NativeTransferPanelChecks {
  static func run() async throws -> [String] {
    let panel = NativeTransferPanel(parent: nil), control = FileTransferControl()
    panel.control = control
    defer { panel.close() }
    var checks: [String] = []
    func expect(_ condition: Bool, _ message: String) throws {
      guard condition else { throw NativeSmoke.Failure(description: message) }; checks.append(message)
    }
    func buttons(_ view: NSView) -> [NSButton] { (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons) }
    let source = URL(fileURLWithPath: "/private/tmp/transfer-ui-fixture")
    panel.update(FileTransferProgress(source: source, completedBytes: 25, totalBytes: 100))
    try expect(panel.label.stringValue == source.lastPathComponent && panel.progress.doubleValue == 25, "Transfer progress displays actual bytes without full-file verification reads")
    var answer: FileTransferDecision?
    panel.problem(FileTransferProblem(source: source, destination: source.appendingPathExtension("copy"), message: "fixture", propertyLoss: true, moving: true)) { answer = $0 }
    try await NativeSmoke.until { panel.window.attachedSheet != nil }
    let choices = panel.window.attachedSheet?.contentView.map(buttons) ?? []
    try expect([NL("重试"), NL("仍然移动"), NL("跳过"), NL("取消")].allSatisfy { title in choices.contains { $0.title == title } }, "Property-loss dialog exposes Retry, explicit Move anyway, Skip and Cancel")
    choices.first { $0.title == NL("跳过") }?.performClick(nil)
    try await NativeSmoke.until { answer != nil }
    try expect(answer == .skip, "Skipping a property-loss sheet returns a skip decision")
    panel.cancel.performClick(nil)
    try expect(control.isCancelled && !panel.cancel.isEnabled, "Transfer Cancel signals the background worker")
    return checks
  }
}
