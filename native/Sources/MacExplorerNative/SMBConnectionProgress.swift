import AppKit
import ExplorerCore

@MainActor
final class SMBConnectionProgress: NSObject {
  private let panel: NSPanel
  private let status = NSTextField(labelWithString: "")
  private let cancelButton = NSButton(title: "", target: nil, action: nil)
  private let session: SMBConnectionSession
  private let owner: UUID
  private var observer: NSObjectProtocol?
  private var closed = false
  init(parent: NSWindow, session: SMBConnectionSession, owner: UUID) {
    self.session = session; self.owner = owner
    panel = NSPanel(contentRect: NSRect(x: parent.frame.midX - 220, y: parent.frame.midY - 65, width: 440, height: 130), styleMask: [.titled], backing: .buffered, defer: false)
    super.init(); panel.title = NL("连接服务器"); panel.isReleasedWhenClosed = false
    let address = NSTextField(labelWithString: session.address ?? ""); address.frame = NSRect(x: 20, y: 85, width: 400, height: 20); address.lineBreakMode = .byTruncatingMiddle
    status.frame = NSRect(x: 20, y: 54, width: 400, height: 20)
    cancelButton.title = NL("取消"); cancelButton.frame = NSRect(x: 330, y: 12, width: 90, height: 30); cancelButton.bezelStyle = .rounded; cancelButton.target = self; cancelButton.action = #selector(cancel)
    for view in [address, status, cancelButton] { panel.contentView?.addSubview(view) }
    parent.addChildWindow(panel, ordered: .above)
    observer = NotificationCenter.default.addObserver(forName: SMBConnectionSession.changed, object: session, queue: .main) { [weak self] _ in Task { @MainActor [weak self] in self?.update() } }
    update()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in guard let self, !self.closed else { return }; self.panel.orderFront(nil) }
  }
  private func update() {
    if !session.isBusy { close(); return }
    status.stringValue = session.message; cancelButton.isEnabled = session.phase != .cancelling
  }
  @objc private func cancel() { session.cancel(owner: owner); update() }
  func close() {
    guard !closed else { return }; closed = true
    if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
    panel.parent?.removeChildWindow(panel); panel.close()
  }
  deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
}
