import AppKit
import ExplorerCore

final class NativeSettingsView: SurfaceView {
  let preferredHeight: CGFloat = 150
  private let title = label(NL("快速访问"), size: 12)
  private let button = ExplorerButton(title: NL("从 Finder 导入收藏夹"), icon: "folder")
  private let status = label("", size: 12)
  private let vcs = NSButton(checkboxWithTitle: NL("启用 Git / SVN 状态角标和右键菜单"), target: nil, action: nil)
  private var toggleVCS: (() -> Void)?
  private let help = NSButton(title: "?", target: nil, action: nil)
  init(browser: BrowserController) {
    super.init(frame: .zero)
    [title, button, status, help, vcs].forEach(addSubview)
    vcs.state = browser.defaults.object(forKey: "versionControl") as? Bool ?? true ? .on : .off
    vcs.target = self; vcs.action = #selector(changeVCS)
    toggleVCS = { [weak self, weak browser] in if let self { browser?.setVersionControl(self.vcs.state == .on) } }
    help.isBordered = false; help.toolTip = NL("读取 Finder 收藏夹并合并到快速访问，保留现有项目和顺序。"); help.setAccessibilityLabel(NL("收藏夹导入说明"))
    button.onPress = { [weak self, weak browser] in
      guard let self, let browser else { return }; self.button.isEnabled = false; self.status.stringValue = NL("正在读取…")
      Task { @MainActor [weak self] in
        do { self?.status.stringValue = try await browser.importFinderFavorites() }
        catch { self?.status.stringValue = error.localizedDescription }
        self?.button.isEnabled = true
      }
    }
  }
  @objc private func changeVCS() { toggleVCS?() }
  required init?(coder: NSCoder) { fatalError() }
  override func layout() {
    super.layout(); title.frame = NSRect(x: 0, y: 0, width: 80, height: 22); help.frame = NSRect(x: 74, y: 0, width: 24, height: 22)
    vcs.frame = NSRect(x: 0, y: 106, width: bounds.width, height: 28)
    button.frame = NSRect(x: 0, y: 28, width: min(bounds.width, 228), height: 34); status.frame = NSRect(x: 0, y: 70, width: bounds.width, height: 20)
  }
}
