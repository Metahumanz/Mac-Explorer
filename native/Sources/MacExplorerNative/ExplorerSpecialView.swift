import AppKit
import ExplorerCore

typealias ExplorerVolume = NativeVolume

final class ExplorerSpecialView: SurfaceView, NetServiceBrowserDelegate, NetServiceDelegate {
  var onNavigate: ((URL) -> Void)?
  // Retained for source compatibility; connections are handled by the Native service.
  var onConnect: ((String) -> Void)?
  var onVolumesChanged: (() -> Void)?
  private var connectionTask: Task<Void, Never>?
  private var ejecting = Set<String>()
  private var mode = ""
  private var revision = 0
  private let scroll = NSScrollView(), document = SurfaceView()
  private let heading = label("", size: 20)
  private let choose = ExplorerButton(title: NL("选择文件"), icon: "plus")
  private let server = NSTextField(string: "smb://")
  private let connect = ExplorerButton(title: NL("连接"), icon: "network")
  private let refresh = ExplorerButton(title: NL("重新扫描"), icon: "refresh")
  private let networkStatus = label("", color: ExplorerPalette.secondary)
  private var discovery = NetServiceBrowser()
  private var services: [NetService] = []
  private var volumes: [ExplorerVolume] = []
  private var cards: [DriveCard] = []
  private var serviceRows: [ExplorerButton] = []
  private let dropArea = AirDropTarget()

  override init(frame: NSRect) {
    super.init(frame: frame)
    scroll.documentView = document; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.drawsBackground = false; scroll.automaticallyAdjustsContentInsets = false
    addSubview(scroll)
    [heading, dropArea, choose, server, connect, refresh, networkStatus].forEach(document.addSubview)
    heading.font = .systemFont(ofSize: 20, weight: .medium)
    server.font = .systemFont(ofSize: 13); server.placeholderString = NL("smb://服务器/共享"); server.bezelStyle = .roundedBezel
    server.target = self; server.action = #selector(connectServer)
    choose.onPress = { [weak self] in self?.chooseFiles() }; connect.onPress = { [weak self] in self?.connectServer() }
    refresh.onPress = { [weak self] in self?.discover() }
    dropArea.onFiles = { [weak self] in self?.share($0) }
    discovery.delegate = self
  }
  required init?(coder: NSCoder) { fatalError() }
  func show(_ name: String) {
    mode = name; revision += 1; let token = revision
    connectionTask?.cancel(); connectionTask = nil; setConnecting(false)
    stopDiscovery(); cards.forEach { $0.removeFromSuperview() }; cards.removeAll(); serviceRows.forEach { $0.removeFromSuperview() }; serviceRows.removeAll()
    heading.stringValue = name == "computer" ? NL("设备和驱动器") : name == "airdrop" ? NL("隔空投送") : NL("网络")
    dropArea.isHidden = name != "airdrop"; choose.isHidden = name != "airdrop"
    for control in [server, connect, refresh] { control.isHidden = name != "network" }
    networkStatus.isHidden = name == "airdrop"; networkStatus.stringValue = ""
    if name == "network" { discover() }
    if name == "computer" || name == "network" { loadVolumes(token: token) }

    needsLayout = true
  }
  private func loadVolumes(token: Int) {
    Task { @MainActor [weak self] in
      do {
        let volumes = try await Task.detached { try NativeVolumes.list() }.value
        guard let self, self.revision == token else { return }; self.volumes = volumes; self.updateVolumes(); self.needsLayout = true
      } catch {
        guard let self, self.revision == token else { return }; self.networkStatus.stringValue = NL(error.localizedDescription)
      }
    }
  }
  private func eject(_ volume: ExplorerVolume) {
    guard !ejecting.contains(volume.path) else { return }; ejecting.insert(volume.path)
    cards.first(where: { $0.volume.path == volume.path })?.isEjecting = true
    let token = revision
    Task { @MainActor [weak self] in
      do {
        let volumes = try await Task.detached { try NativeVolumes.eject(volume.url) }.value
        guard let self else { return }; self.ejecting.remove(volume.path); self.onVolumesChanged?()
        guard self.revision == token else { return }; self.volumes = volumes; self.updateVolumes(); self.needsLayout = true
      } catch {
        guard let self else { return }; self.ejecting.remove(volume.path)
        guard self.revision == token else { return }; self.networkStatus.stringValue = NL(error.localizedDescription)
        self.cards.first(where: { $0.volume.path == volume.path })?.isEjecting = false
      }
    }
  }
  private func stopDiscovery() {
    discovery.delegate = nil; discovery.stop()
    for service in services { service.delegate = nil; service.stop() }; services.removeAll()
  }
  override var isHidden: Bool {
    didSet {
      if isHidden, !oldValue { revision += 1; stopDiscovery(); connectionTask?.cancel(); connectionTask = nil; setConnecting(false) }
    }
  }
  override func viewWillMove(toWindow newWindow: NSWindow?) {
    if newWindow == nil { revision += 1; stopDiscovery(); connectionTask?.cancel(); connectionTask = nil }
    super.viewWillMove(toWindow: newWindow)
  }
  private func updateVolumes() {
    cards.forEach { $0.removeFromSuperview() }; cards.removeAll()
    let visible = mode == "computer" ? volumes : volumes.filter { !$0.local }
    if mode == "computer" { heading.stringValue = NL("设备和驱动器（{0}）", visible.count) }
    for volume in visible {
      let card = DriveCard(volume: volume); card.open = { [weak self] in self?.onNavigate?(volume.url) }; card.eject = { [weak self] in self?.eject(volume) }; card.isEjecting = ejecting.contains(volume.path); document.addSubview(card); cards.append(card)
    }
  }
  override func layout() {
    super.layout(); scroll.frame = bounds
    let width = scroll.contentSize.width
    heading.frame = NSRect(x: 30, y: 26, width: width - 60, height: 28)
    var bottom: CGFloat = 80
    if mode == "airdrop" {
      dropArea.frame = NSRect(x: 32, y: 80, width: max(0, width - 64), height: 270)
      choose.frame = NSRect(x: (width - 110) / 2, y: 270, width: 110, height: 34); bottom = 380
    } else if mode == "computer" {
      let columns = max(1, Int((width - 60 + 16) / 376))
      let cardWidth = min(436, (width - 60 - CGFloat(columns - 1) * 16) / CGFloat(columns))
      for (index, card) in cards.enumerated() { card.frame = NSRect(x: 30 + CGFloat(index % columns) * (cardWidth + 16), y: 70 + CGFloat(index / columns) * 128, width: cardWidth, height: 112) }
      bottom = 90 + CGFloat((cards.count + columns - 1) / columns) * 128
      networkStatus.frame = NSRect(x: 32, y: bottom, width: max(0, width - 64), height: 24); bottom += 32
    } else {
      server.frame = NSRect(x: 32, y: 88, width: max(100, min(width - 170, 560)), height: 34)
      connect.frame = NSRect(x: server.frame.maxX + 12, y: 88, width: 80, height: 34)
      refresh.frame = NSRect(x: width - 136, y: 150, width: 104, height: 34)
      networkStatus.frame = NSRect(x: 32, y: 160, width: width - 185, height: 20)
      var y: CGFloat = 202
      for button in serviceRows { button.frame = NSRect(x: 32, y: y, width: width - 64, height: 46); y += 54 }
      for card in cards { card.frame = NSRect(x: 32, y: y, width: min(436, width - 64), height: 112); y += 128 }
      bottom = y + 32
    }
    document.frame = NSRect(x: 0, y: 0, width: width, height: max(bounds.height, bottom))
  }
  private func chooseFiles() {
    guard let window else { return }; let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = true; panel.allowsMultipleSelection = true
    panel.beginSheetModal(for: window) { [weak self] result in if result == .OK { self?.share(panel.urls) } }
  }
  private func share(_ urls: [URL]) {
    guard let service = NSSharingService(named: .sendViaAirDrop), !urls.isEmpty else { return }
    service.perform(withItems: urls)
  }
  private func setConnecting(_ busy: Bool) {
    connect.title = busy ? NL("取消") : NL("连接"); connect.isEnabled = true; server.isEnabled = !busy; refresh.isEnabled = !busy
    for (row, service) in zip(serviceRows, services) { row.isEnabled = !busy && service.hostName != nil && service.port > 0 }
  }
  @objc private func connectServer() {
    if let task = connectionTask { task.cancel(); connect.isEnabled = false; networkStatus.stringValue = NL("正在取消…"); return }
    let input = server.stringValue
    do { _ = try NativeNetwork.validate(input) } catch { networkStatus.stringValue = NL(error.localizedDescription); return }
    let token = revision; setConnecting(true); networkStatus.stringValue = NL("正在连接…")
    connectionTask = Task { @MainActor [weak self] in
      do {
        let directory = try await NativeNetwork.shared.connection(input)
        guard let self, self.revision == token else { return }; self.connectionTask = nil; self.setConnecting(false)
        if let directory { self.networkStatus.stringValue = ""; self.onVolumesChanged?(); self.onNavigate?(directory) }
        else { self.networkStatus.stringValue = NL("已取消") }
      } catch {
        guard let self, self.revision == token else { return }; self.connectionTask = nil; self.setConnecting(false); self.networkStatus.stringValue = NL(error.localizedDescription)
      }
    }
  }
  private func discover() {
    stopDiscovery(); discovery = NetServiceBrowser(); discovery.delegate = self
    updateServices(); networkStatus.stringValue = NL("正在查找共享电脑…")
    discovery.searchForServices(ofType: "_smb._tcp.", inDomain: "local.")
    let token = revision, browser = discovery
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self, weak browser] in
      guard let self, self.revision == token, self.discovery === browser, self.connectionTask == nil else { return }
      self.networkStatus.stringValue = self.services.isEmpty ? NL("未发现共享电脑") : NL("共享电脑（{0}）", self.services.count)
    }
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    guard browser === discovery, mode == "network", !services.contains(where: { $0.name == service.name && $0.domain == service.domain && $0.type == service.type }) else { return }
    services.append(service); service.delegate = self; service.resolve(withTimeout: 5); if !moreComing { updateServices() }
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    guard browser === discovery else { return }; service.delegate = nil; service.stop(); services.removeAll { $0 == service }; if !moreComing { updateServices() }
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) { guard browser === discovery, connectionTask == nil else { return }; networkStatus.stringValue = NL("无法发现共享电脑") }
  func netServiceDidResolveAddress(_ sender: NetService) { guard services.contains(sender) else { return }; updateServices() }

  private func updateServices() {
    serviceRows.forEach { $0.removeFromSuperview() }; serviceRows.removeAll()
    for service in services {
      let row = ExplorerButton(title: service.name, icon: "computer") { [weak self, weak service] in
        guard let self, let service, let host = service.hostName, service.port > 0 else { return }
        var address = URLComponents(); address.scheme = "smb"; address.host = host; if service.port != 445 { address.port = service.port }
        guard let value = address.url?.absoluteString else { return }; self.server.stringValue = value; self.connectServer()
      }
      row.isEnabled = connectionTask == nil && service.hostName != nil && service.port > 0
      row.alignment = .left
      row.toolTip = service.hostName; document.addSubview(row); serviceRows.append(row)
    }
    if connectionTask == nil { networkStatus.stringValue = services.isEmpty ? NL("未发现共享电脑") : NL("共享电脑（{0}）", services.count) }; needsLayout = true
  }
  deinit { discovery.delegate = nil; discovery.stop(); services.forEach { $0.delegate = nil; $0.stop() }; connectionTask?.cancel() }
}

private final class DriveCard: SurfaceView {
  let volume: ExplorerVolume
  var open: (() -> Void)?
  var eject: (() -> Void)?
  var isEjecting = false { didSet { ejectButton.isEnabled = !isEjecting } }
  private let ejectButton = NSButton(title: "", target: nil, action: nil)
  private let icon = NSImageView(), name = label("", size: 15), kind = label("", size: 11, color: ExplorerPalette.secondary), capacity = label("", size: 11, color: ExplorerPalette.secondary)
  private var selected = false
  init(volume: ExplorerVolume) {
    self.volume = volume; super.init(frame: .zero)
    [icon, name, kind, capacity, ejectButton].forEach(addSubview)
    ejectButton.isBordered = false; ejectButton.image = NSImage(systemSymbolName: "eject", accessibilityDescription: NL("推出")); ejectButton.toolTip = NL("推出"); ejectButton.setAccessibilityLabel(NL("推出")); ejectButton.target = self; ejectButton.action = #selector(ejectVolume); ejectButton.isHidden = !volume.canEject
    icon.image = NSWorkspace.shared.icon(forFile: volume.url.path); icon.imageScaling = .scaleProportionallyUpOrDown
    name.stringValue = volume.name; name.font = .systemFont(ofSize: 15, weight: .semibold)
    kind.stringValue = volume.local ? NL("本地磁盘") : NL("网络位置")
    capacity.stringValue = NL("{0} 可用，共 {1}", ExplorerFormat.size(volume.free), ExplorerFormat.size(volume.total))
    toolTip = capacity.stringValue
    setAccessibilityRole(.button); setAccessibilityLabel(volume.name + "，" + capacity.stringValue)
  }
  required init?(coder: NSCoder) { fatalError() }
  @objc private func ejectVolume() { eject?() }
  override func layout() { super.layout(); ejectButton.frame = NSRect(x: bounds.width - 40, y: 14, width: 26, height: 26); icon.frame = NSRect(x: 22, y: 24, width: 64, height: 64); name.frame = NSRect(x: 108, y: 17, width: bounds.width - (volume.canEject ? 158 : 130), height: 22); kind.frame = NSRect(x: 108, y: 41, width: bounds.width - 130, height: 17); capacity.frame = NSRect(x: 108, y: 79, width: bounds.width - 130, height: 18) }
  override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self); if event.clickCount == 2 { open?() } }
  override func becomeFirstResponder() -> Bool { selected = true; needsDisplay = true; return true }
  override func resignFirstResponder() -> Bool { selected = false; needsDisplay = true; return true }
  override func accessibilityPerformPress() -> Bool { open?(); return true }
  override var acceptsFirstResponder: Bool { true }
  override func keyDown(with event: NSEvent) { if event.keyCode == 36 { open?() } else { super.keyDown(with: event) } }
  override func draw(_ dirtyRect: NSRect) {
    let frame = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
    (selected ? ExplorerPalette.selection : ExplorerPalette.sidebar).setFill(); frame.fill(); ExplorerPalette.border.setStroke(); frame.stroke()
    let track = NSRect(x: 108, y: 65, width: max(0, bounds.width - 130), height: 6)
    ExplorerPalette.active.setFill(); NSBezierPath(roundedRect: track, xRadius: 3, yRadius: 3).fill()
    let fraction = volume.total > 0 ? min(1, max(0, 1 - Double(volume.free) / Double(volume.total))) : 0
    NSColor(srgbRed: 66 / 255, green: 160 / 255, blue: 218 / 255, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: track.minX, y: track.minY, width: track.width * fraction, height: 6), xRadius: 3, yRadius: 3).fill()
  }
}

private final class AirDropTarget: SurfaceView {
  var onFiles: (([URL]) -> Void)?
  override init(frame: NSRect) { super.init(frame: frame); registerForDraggedTypes([.fileURL]) }
  required init?(coder: NSCoder) { fatalError() }
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool { let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []; guard !urls.isEmpty else { return false }; onFiles?(urls); return true }
  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 4, yRadius: 4); path.setLineDash([4, 4], count: 2, phase: 0); ExplorerPalette.border.setStroke(); path.stroke()
    ExplorerIcons.image("airdrop", size: 48, color: ExplorerPalette.accent).draw(in: NSRect(x: bounds.midX - 24, y: 54, width: 48, height: 48), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    let title = NL("拖放文件到此处") as NSString, attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 16), .foregroundColor: ExplorerPalette.text]
    title.draw(at: NSPoint(x: bounds.midX - title.size(withAttributes: attrs).width / 2, y: 120), withAttributes: attrs)
  }
}
