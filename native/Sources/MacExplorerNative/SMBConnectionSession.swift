import AppKit
import ExplorerCore
import Darwin

@MainActor
final class SMBConnectionSession {
  static let shared = SMBConnectionSession(observeMounts: true)
  static let changed = Notification.Name("NativeExplorerSMBConnectionChanged")
  enum Phase: Equatable { case idle, connecting, cancelling, connected, cancelled, failed(String) }
  private(set) var phase: Phase = .idle
  private(set) var address: String?
  private(set) var connectedPaths: [String: URL] = [:]
  private(set) var missingAddresses = Set<String>()
  private(set) var mountRevision: UInt64 = 0
  private var task: Task<Void, Never>?
  private var owner: UUID?
  private var attempt = UUID()
  enum MountEvidence { case mounted(String), missing, unknown }
  private let mountEvidence: (URL) -> MountEvidence
  private var mountIdentities: [String: String] = [:]
  private var workspaceObservers: [NSObjectProtocol] = []
  private let connection: (String) async throws -> URL?
  var isBusy: Bool { task != nil }
  var message: String {
    switch phase {
    case .idle: return ""
    case .connecting: return NL("正在连接…")
    case .cancelling: return NL("正在取消…")
    case .connected: return NL("已连接")
    case .cancelled: return NL("已取消")
    case .failed(let message): return message
    }
  }
  init(observeMounts: Bool = false, mountEvidence: ((URL) -> MountEvidence)? = nil, connection: @escaping (String) async throws -> URL? = { try await NativeNetwork.shared.connection($0) }) {
    self.connection = connection; self.mountEvidence = mountEvidence ?? Self.systemMountEvidence
    if observeMounts {
      for name in [NSWorkspace.didMountNotification, NSWorkspace.didUnmountNotification, NSWorkspace.didWakeNotification] {
        workspaceObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          Task { @MainActor [weak self] in
            if name == NSWorkspace.didWakeNotification { self?.invalidateMounts() }
            else { self?.refreshMountProofs() }
          }
        })
      }
    }
  }
  func begin(_ input: String, owner: UUID, finished: ((Phase) -> Void)? = nil, completion: @escaping (URL) -> Void) throws {
    let canonical = try SavedSMBConnection.canonicalAddress(input)
    guard task == nil else { throw NativeNetwork.failure("正在连接服务器，请稍候。") }
    self.owner = owner; address = canonical; phase = .connecting; let token = UUID(); attempt = token
    let connection = connection
    task = Task { @MainActor [weak self] in
      do {
        try Task.checkCancellation()
        let result = try await connection(canonical)
        guard let self, self.attempt == token else { return }
        let requestedCancel = self.phase == .cancelling
        self.task = nil; self.owner = nil
        if let result {
          // No guessing from a share name, and no persisted path reused after restart.
          self.mountRevision &+= 1; self.connectedPaths[canonical] = result
          if case .mounted(let identity) = self.mountEvidence(result) { self.mountIdentities[canonical] = identity }
          else { self.mountIdentities.removeValue(forKey: canonical) }; self.missingAddresses.remove(canonical); self.phase = .connected
          self.notify(); finished?(self.phase)
          if !requestedCancel { completion(result) }
        } else { self.phase = .cancelled; self.notify(); finished?(self.phase) }
      } catch {
        guard let self, self.attempt == token else { return }
        self.task = nil; self.owner = nil
        self.phase = error is CancellationError ? .cancelled : .failed(error.localizedDescription)
        self.notify(); finished?(self.phase)
      }
    }
    notify()
  }
  func cancel(owner: UUID? = nil) {
    guard let task, owner == nil || owner == self.owner, phase != .cancelling else { return }
    phase = .cancelling; task.cancel(); notify()
  }
  func reconcile(_ volumes: [NativeVolume]) {
    let available = Set(volumes.map(\.path))
    for (address, url) in connectedPaths where !available.contains(url.path) {
      connectedPaths.removeValue(forKey: address); mountIdentities.removeValue(forKey: address); missingAddresses.insert(address)
      if self.address == address, !isBusy, phase == .connected { phase = .idle }
    }
  }
  func status(for item: SavedSMBConnection, volumes: [NativeVolume], readFailed: Bool) -> String {
    if address == item.address {
      if isBusy { return message }
      if case .failed = phase { return NL("连接失败") }
    }
    if readFailed { return NL("读取失败") }
    if let path = connectedPaths[item.address], let volume = volumes.first(where: { $0.url == path }) {
      if volume.kind == .local { return NL("待连接") }
      return volume.kind == .unknown || volume.capacityState == .unavailable ? NL("读取失败") : NL("已挂载")
    }
    return missingAddresses.contains(item.address) ? NL("未挂载") : NL("待连接")
  }
  /// Cached kernel mount identity avoids both stale paths and late notifications for this same mount.
  func refreshMountProofs() {
    mountRevision &+= 1
    for (address, url) in connectedPaths {
      switch mountEvidence(url) {
      case .mounted(let identity) where mountIdentities[address] == identity: continue
      case .missing: missingAddresses.insert(address)
      case .unknown, .mounted: missingAddresses.remove(address)
      }
      connectedPaths.removeValue(forKey: address); mountIdentities.removeValue(forKey: address)
      if self.address == address, !isBusy { phase = .idle }
    }
    notify()
  }
  private static func systemMountEvidence(_ url: URL) -> MountEvidence {
    var buffer: UnsafeMutablePointer<statfs>?
    let count = getmntinfo_r_np(&buffer, MNT_NOWAIT)
    guard count > 0, let buffer else { return .unknown }; defer { Darwin.free(buffer) }
    for index in 0..<Int(count) {
      var value = buffer[index]
      let path = withUnsafePointer(to: &value.f_mntonname) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) } }
      if path == url.path { return .mounted("\(value.f_fsid.val.0):\(value.f_fsid.val.1)") }
    }
    return .missing
  }
  func invalidateMounts() {
    mountRevision &+= 1
    connectedPaths.removeAll(); mountIdentities.removeAll(); missingAddresses.removeAll()
    if !isBusy { phase = .idle }
    notify()
  }
  private func notify() { NotificationCenter.default.post(name: Self.changed, object: self) }
  deinit { for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }; task?.cancel() }
}
