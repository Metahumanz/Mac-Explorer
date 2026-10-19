import AppKit
import ExplorerCore

final class NativeSettingsView: SurfaceView {
  var preferredHeight: CGFloat { status.stringValue.isEmpty ? 34 : 62 }
  var onHeightChange: (() -> Void)?
  private let button = EDButton(title: NL("从 Finder 导入收藏夹"), style: .secondary)
  private let status = label("", size: 12)
  private let help = NativeHelpButton(text: NL("读取 Finder 收藏夹并合并到快速访问，保留现有项目和顺序。"), accessibilityLabel: NL("收藏夹导入说明"))
  init(browser: BrowserController) {
    super.init(frame: .zero); color = .clear
    button.iconName = "folder"
    [button, status, help].forEach(addSubview)
    button.onPress = { [weak self, weak browser] in
      guard let self, let browser else { return }; self.button.isEnabled = false; self.setStatus(NL("正在读取…"))
      Task { @MainActor [weak self] in
        do { self?.setStatus(try await browser.importFinderFavorites()) }
        catch { self?.setStatus(error.localizedDescription) }
        self?.button.isEnabled = true
      }
    }
  }
  required init?(coder: NSCoder) { fatalError() }
  private func setStatus(_ value: String) {
    status.stringValue = value; onHeightChange?()
  }
  override func layout() {
    super.layout(); help.frame = NSRect(x: bounds.width - 24, y: 0, width: 24, height: 34)
    button.frame = NSRect(x: 0, y: 0, width: min(bounds.width - 32, 228), height: 34); status.frame = NSRect(x: 0, y: 40, width: bounds.width, height: 20)
  }
}
