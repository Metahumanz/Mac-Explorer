import AppKit
import ExplorerCore

final class NativeSystemSettingsView: SurfaceView {
  let preferredHeight: CGFloat = 186
  private let integration: NativeSystemIntegration
  private let viewer = NSButton(checkboxWithTitle: NL("使用 Mac Explorer 显示文件"), target: nil, action: nil)
  private let help = NSButton(title: "?", target: nil, action: nil)
  private let wakeTitle = label(NL("唤醒快捷键"), size: 12)
  private let wake = EDShortcutRecorder(value: "")
  private let save = NSButton(title: NL("保存快捷键"), target: nil, action: nil)
  private let clear = NSButton(title: NL("清除"), target: nil, action: nil)
  private let status = label("", size: 12)
  init(integration: NativeSystemIntegration) {
    self.integration = integration; super.init(frame: .zero)
    [viewer, help, wakeTitle, wake, save, clear, status].forEach(addSubview)
    viewer.target = self; viewer.action = #selector(toggleViewer)
    help.isBordered = false; help.toolTip = NL("使用 Mac Explorer 处理部分系统“在文件夹中显示”请求；关闭后恢复原设置。Finder 仍保留。")
    help.setAccessibilityLabel(NL("系统文件查看器说明"))
    wake.value = integration.wakeShortcut
    wake.captureChanged = { [weak integration] in integration?.captureShortcut($0) }
    wake.onRecord = { [weak self] value in self?.wake.value = value; return true }
    wake.onError = { [weak self] in self?.status.stringValue = $0 }
    wake.setAccessibilityLabel(NL("唤醒快捷键")); save.target = self; save.action = #selector(saveWake); clear.target = self; clear.action = #selector(clearWake)
    status.stringValue = integration.wakeError
    refreshViewer()
  }
  required init?(coder: NSCoder) { fatalError() }
  private func refreshViewer() {
    do { let value = try integration.fileViewer.perform("status"); viewer.state = value.enabled ? .on : .off; viewer.isEnabled = !value.enabled || value.canRestore; if !value.error.isEmpty { status.stringValue = NL(value.error) } }
    catch { viewer.isEnabled = false; status.stringValue = NL(error.localizedDescription) }
  }
  @objc private func toggleViewer() {
    let enabling = viewer.state == .on
    let alert = NSAlert(); alert.messageText = enabling ? NL("使用 Mac Explorer 显示文件？") : NL("恢复原文件查看器设置？")
    alert.addButton(withTitle: NL("确定")); alert.addButton(withTitle: NL("取消"))
    guard alert.runModal() == .alertFirstButtonReturn else { refreshViewer(); return }
    do { _ = try integration.fileViewer.perform(enabling ? "enable" : "restore"); status.stringValue = NL("已保存") }
    catch { status.stringValue = NL(error.localizedDescription) }
    refreshViewer()
  }
  @objc private func saveWake() {
    do { try integration.setWakeShortcut(wake.value); wake.value = integration.wakeShortcut; status.stringValue = NL("已保存") }
    catch { status.stringValue = NL(error.localizedDescription) }
  }
  @objc private func clearWake() { wake.value = ""; saveWake() }
  override func layout() {
    super.layout(); let width = bounds.width
    viewer.frame = NSRect(x: 0, y: 0, width: min(300, width - 30), height: 28); help.frame = NSRect(x: min(300, width - 30), y: 0, width: 24, height: 28)
    wakeTitle.frame = NSRect(x: 0, y: 44, width: width, height: 20)
    wake.frame = NSRect(x: 0, y: 72, width: max(100, width - 190), height: 28)
    save.frame = NSRect(x: max(110, width - 182), y: 71, width: 112, height: 30); clear.frame = NSRect(x: max(222, width - 66), y: 71, width: 66, height: 30)
    status.frame = NSRect(x: 0, y: 114, width: width, height: 44); status.maximumNumberOfLines = 2
  }
}
