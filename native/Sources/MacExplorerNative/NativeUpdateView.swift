import AppKit
import CryptoKit
import ExplorerCore

@MainActor
private final class NativeUpdateCoordinator {
  private static var instances: [String: NativeUpdateCoordinator] = [:]
  static func current() -> NativeUpdateCoordinator {
    let app = Bundle.main.bundleURL.resolvingSymlinksInPath(), key = app.path
    if let value = instances[key] { return value }
    let value = NativeUpdateCoordinator(app: app); instances[key] = value; return value
  }
  let updates: NativeUpdates
  private var task: Task<Void, Never>?
  private(set) var installationError = ""
  var isBusy: Bool { task != nil }
  private init(app: URL) {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
    let identity = Bundle.main.bundleIdentifier ?? "native-development"
    let digest = SHA256.hash(data: Data(app.path.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Mac Explorer Native/updates/\(identity)-\(digest)")
    updates = NativeUpdates(version: version, app: app, cache: cache)
  }
  func perform(_ status: String) {
    guard task == nil else { return }; installationError = ""
    // The update belongs to the application, so closing Settings does not cancel it.
    task = Task {
      defer { task = nil }
      if status == "ready" {
        do {
          let installer = try await updates.installer()
          guard let delegate = NSApp.delegate as? ApplicationDelegate else { throw NativeUpdateValidation.failure("无法准备更新安装。") }
          try delegate.installUpdateAndTerminate { try installer.launch(pid: ProcessInfo.processInfo.processIdentifier) }
        }
        catch { installationError = NL(error.localizedDescription) }
      } else if status == "available" { await updates.download() }
      else { await updates.check() }
    }
  }
}

@MainActor
final class NativeUpdateView: SurfaceView {
  let preferredHeight: CGFloat = 174
  private let coordinator = NativeUpdateCoordinator.current()
  private let version = label("", size: 12)
  private let status = label("", size: 12)
  private let progress = NSProgressIndicator()
  private let action = NSButton(title: NL("检查更新"), target: nil, action: nil)
  private let releases = NSButton(title: "GitHub", target: nil, action: nil)
  private var current = NativeUpdateState(currentVersion: "0.1.0")
  private var poll: Timer?
  init() {
    super.init(frame: .zero)
    [version, status, progress, action, releases].forEach(addSubview)
    version.stringValue = NL("当前版本：{0}", Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0")
    action.target = self; action.action = #selector(performAction); releases.target = self; releases.action = #selector(openReleases)
    progress.style = .bar; progress.isIndeterminate = true; progress.isHidden = true
    status.maximumNumberOfLines = 2
    poll = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      Task { @MainActor [weak self] in guard let self else { return }; self.current = await self.coordinator.updates.state; self.render() }
    }
    Task { @MainActor [weak self] in guard let self else { return }; self.current = await self.coordinator.updates.state; self.render() }
    render()
  }
  required init?(coder: NSCoder) { fatalError() }
  deinit { poll?.invalidate() }
  @objc private func openReleases() { NSWorkspace.shared.open(URL(string: "https://github.com/qixiaoyu27/Mac-Explorer/releases")!) }
  @objc private func performAction() {
    if current.status == "ready" {
      let alert = NSAlert(); alert.messageText = NL("退出并安装更新？"); alert.addButton(withTitle: NL("安装")); alert.addButton(withTitle: NL("取消"))
      guard alert.runModal() == .alertFirstButtonReturn else { return }
    }
    coordinator.perform(current.status); render()
  }
  private func render() {
    let busy = coordinator.isBusy || ["checking", "downloading", "verifying", "installing"].contains(current.status)
    action.isEnabled = !busy
    action.title = current.status == "available" ? NL("下载更新") : current.status == "ready" ? NL("退出并安装") : NL("检查更新")
    let labels = ["idle":"", "checking": NL("正在检查更新…"), "current": NL("已是最新版本"), "available": NL("发现新版本：{0}", current.latestVersion ?? ""), "downloading": NL("正在下载更新…"), "verifying": NL("正在校验更新…"), "ready": NL("更新已就绪"), "installing": NL("正在安装更新…")]
    status.stringValue = !coordinator.installationError.isEmpty ? coordinator.installationError : current.error.isEmpty ? labels[current.status] ?? "" : current.error
    progress.isHidden = !busy; progress.isIndeterminate = current.status != "downloading"; progress.maxValue = Double(max(1, current.total)); progress.doubleValue = Double(current.downloaded)
    if busy, progress.isIndeterminate { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
  }
  override func layout() {
    super.layout(); version.frame = NSRect(x: 0, y: 0, width: bounds.width, height: 22)
    status.frame = NSRect(x: 0, y: 30, width: bounds.width, height: 42); progress.frame = NSRect(x: 0, y: 78, width: bounds.width, height: 14)
    action.frame = NSRect(x: 0, y: 112, width: 146, height: 30); releases.frame = NSRect(x: 156, y: 112, width: 92, height: 30)
  }
}
