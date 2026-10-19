import AppKit

final class NativeHelpButton: NSButton {
  private let popover = NSPopover()
  private var keepOpen = false

  init(text: String, accessibilityLabel: String) {
    super.init(frame: .zero)
    title = "?"; isBordered = false; target = self; action = #selector(showHelp)
    setAccessibilityLabel(accessibilityLabel); setAccessibilityHelp(text)
    let message = NSTextField(wrappingLabelWithString: text)
    message.font = .systemFont(ofSize: 12)
    let height = ceil((text as NSString).boundingRect(with: NSSize(width: 276, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: message.font!]).height) + 4
    let controller = NSViewController()
    controller.view = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: height + 24))
    message.frame = NSRect(x: 12, y: 12, width: 276, height: height)
    controller.view.addSubview(message)
    popover.contentViewController = controller; popover.behavior = .transient; popover.animates = false
  }
  required init?(coder: NSCoder) { fatalError() }
  override var acceptsFirstResponder: Bool { true }
  override func updateTrackingAreas() {
    super.updateTrackingAreas(); trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
  }
  private func presentHelp() {
    guard window != nil, !popover.isShown else { return }
    popover.show(relativeTo: bounds, of: self, preferredEdge: .minX)
  }
  @objc private func showHelp() { keepOpen = true; presentHelp() }
  override func mouseEntered(with event: NSEvent) { keepOpen = false; presentHelp() }
  override func mouseExited(with event: NSEvent) { if !keepOpen { popover.close() } }
  override func becomeFirstResponder() -> Bool {
    guard super.becomeFirstResponder() else { return false }
    presentHelp(); return true
  }
  override func resignFirstResponder() -> Bool {
    if !keepOpen { popover.close() }; return super.resignFirstResponder()
  }
  override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); if window == nil { popover.close() } }
}
