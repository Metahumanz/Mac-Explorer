import Foundation
import AppKit
import NetFS
import Darwin

public struct NativeVolume: Equatable, Sendable {
  public let url: URL
  public let name: String
  public let total: Int64
  public let free: Int64
  public let local: Bool
  public let canEject: Bool
  public var isNetwork: Bool { !local }
  public var path: String { url.path }
  public init(url: URL, name: String, total: Int64, free: Int64, local: Bool, canEject: Bool) {
    self.url = url; self.name = name; self.total = max(0, total); self.free = max(0, free); self.local = local; self.canEject = url.path != "/" && canEject
  }
}

public enum NativeVolumes {
  public static func list() throws -> [NativeVolume] {
    let keys: Set<URLResourceKey> = [.volumeNameKey, .volumeTotalCapacityKey, .volumeAvailableCapacityKey, .volumeIsLocalKey, .volumeIsEjectableKey, .volumeIsRemovableKey]
    return (FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: Array(keys), options: [.skipHiddenVolumes]) ?? []).compactMap { url in
      guard url.path == "/" || url.path.hasPrefix("/Volumes/"), let values = try? url.resourceValues(forKeys: keys) else { return nil }
      return NativeVolume(url: url, name: values.volumeName ?? url.lastPathComponent, total: Int64(values.volumeTotalCapacity ?? 0), free: Int64(values.volumeAvailableCapacity ?? 0), local: values.volumeIsLocal ?? true,
        canEject: values.volumeIsEjectable == true || values.volumeIsRemovable == true || values.volumeIsLocal == false)
    }.sorted { a, b in if a.url.path == "/" { return b.url.path != "/" }; if b.url.path == "/" { return false }; return a.name.localizedStandardCompare(b.name) == .orderedAscending }
  }
  public static func eject(_ url: URL) throws -> [NativeVolume] {
    let selected = try ejectable(url, among: list())
    try NSWorkspace.shared.unmountAndEjectDevice(at: selected.url)
    return try list()
  }
  public static func ejectable(_ url: URL, among volumes: [NativeVolume]) throws -> NativeVolume {
    guard url.isFileURL, [nil, "", "localhost"].contains(url.host), url.query == nil, url.fragment == nil, url.path != "/", url.path.hasPrefix("/Volumes/"), url.standardizedFileURL.path == url.path,
      !url.path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
      let volume = volumes.first(where: { $0.url.path == url.path && $0.canEject }), volume.url.path != "/" else {
      throw NativeNetwork.failure("此位置不是可推出的已挂载磁盘。")
    }
    return volume
  }
}

struct NativeMountAPI {
  let start: (URL, DispatchQueue, @escaping (Int32, [String]?) -> Void) -> (Int32, UnsafeMutableRawPointer?)
  let cancel: (UnsafeMutableRawPointer) -> Int32
  static let live = NativeMountAPI(start: { url, queue, completion in
    var request: AsyncRequestID?
    let status = NetFSMountURLAsync(url as CFURL, nil, nil, nil, nil, nil, &request, queue) { status, _, mounts in completion(status, mounts as? [String]) }
    return (status, request)
  }, cancel: { NetFSMountURLCancel($0) })
}

// All NetFS state and completions run on one queue, including cancellation before startup.
final class NativeMountRequest: @unchecked Sendable {
  private let queue = DispatchQueue(label: "local.macexplorer.native.smb")
  private let api: NativeMountAPI
  private var continuation: CheckedContinuation<[String]?, Error>?
  private var token: UnsafeMutableRawPointer?
  private var timer: DispatchWorkItem?
  private var cancelled = false
  private var finished = false
  init(api: NativeMountAPI = .live) { self.api = api }
  func run(_ url: URL, timeout: TimeInterval = 120) async throws -> [String]? {
    try await withTaskCancellationHandler(operation: {
      try await withCheckedThrowingContinuation { continuation in
        queue.async {
          self.continuation = continuation
          if self.cancelled || Task.isCancelled { self.complete(.success(nil)); return }
          let (status, token) = self.api.start(url, self.queue) { status, paths in
            if status == -128 { self.complete(.success(nil)) }
            else if status == 0 || (status == EEXIST && paths?.isEmpty == false) { self.complete(.success(paths ?? [])) }
            else { self.complete(.failure(NSError(domain: status > 0 ? NSPOSIXErrorDomain : NSOSStatusErrorDomain, code: Int(status)))) }
          }
          guard !self.finished else { return }
          if status == -128 { self.complete(.success(nil)); return }
          guard status == 0, let token else {
            self.complete(.failure(NSError(domain: status > 0 ? NSPOSIXErrorDomain : NSOSStatusErrorDomain, code: Int(status == 0 ? EIO : status)))); return
          }
          self.token = token
          let timer = DispatchWorkItem { [weak self] in self?.cancel(timedOut: true) }
          self.timer = timer; self.queue.asyncAfter(deadline: .now() + timeout, execute: timer)
        }
      }
    }, onCancel: { self.queue.async { self.cancel(timedOut: false) } })
  }
  private func cancel(timedOut: Bool) {
    guard !finished else { return }; cancelled = true
    guard let token else { return }
    // A failed NetFS cancellation is still pending; only its real completion may release the connection guard.
    guard api.cancel(token) == 0 else { return }
    if timedOut { complete(.failure(NativeNetwork.failure("连接超时，请重试。"))) }
    else { complete(.success(nil)) }
  }
  private func complete(_ result: Result<[String]?, Error>) {
    guard !finished else { return }; finished = true; timer?.cancel(); timer = nil; token = nil
    let continuation = self.continuation; self.continuation = nil; continuation?.resume(with: result)
  }
}

public actor NativeNetwork {
  public static let shared = NativeNetwork()
  public private(set) var isConnecting = false
  public init() {}
  public static func failure(_ message: String) -> NSError { NSError(domain: "MacExplorer.Network", code: 1, userInfo: [NSLocalizedDescriptionKey: NL(message)]) }
  public static func validate(_ input: String) throws -> URL {
    let failure = Self.failure("请输入有效的 SMB 服务器地址，例如 smb://server/share。")
    guard !input.isEmpty, input.utf16.count <= 2048, !input.contains("\\"), !input.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw failure }
    let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard value.lowercased().hasPrefix("smb://"), var parts = URLComponents(string: value), parts.scheme?.lowercased() == "smb",
      let host = parts.host, !host.isEmpty, host != ".", host != "..", !host.contains("@"), !host.contains("\\"),
      !host.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      parts.port.map({ (1...65535).contains($0) }) ?? true else { throw failure }
    let authority = String(value.dropFirst(6).split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)[0])
    guard !authority.hasSuffix(":"), let path = parts.percentEncodedPath.removingPercentEncoding, !path.contains("\\"),
      !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw failure }
    if host.hasPrefix("[") || host.hasSuffix("]") {
      guard host.hasPrefix("["), host.hasSuffix("]") else { throw failure }
      var address = in6_addr(); guard String(host.dropFirst().dropLast()).withCString({ inet_pton(AF_INET6, $0, &address) }) == 1 else { throw failure }
    }
    if !host.hasPrefix("[") { guard host.rangeOfCharacter(from: CharacterSet(charactersIn: "/:@?#[]%")) == nil else { throw failure } }
    parts.scheme = "smb"
    guard let url = parts.url else { throw failure }; return url
  }
  public func connection(_ input: String) async throws -> URL? {
    try await connect(input) { url in try await NativeMountRequest().run(url) }
  }
  // The injected mount operation keeps concurrency checks testable without contacting a real server.
  func connect(_ input: String, mount: @escaping (URL) async throws -> [String]?) async throws -> URL? {
    let url = try Self.validate(input)
    guard !isConnecting else { throw Self.failure("正在连接服务器，请稍候。") }
    isConnecting = true; defer { isConnecting = false }
    guard let paths = try await mount(url) else { return nil }
    return try Self.mountedDirectory(paths)
  }
  public static func mountedDirectory(_ paths: [String]) throws -> URL {
    guard !paths.isEmpty, paths.count <= 1024 else { throw failure("系统未返回已挂载的共享目录。") }
    for path in paths {
      guard path.hasPrefix("/"), !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw failure("系统返回的共享目录无效。") }
      let url = URL(fileURLWithPath: path)
      guard (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { continue }
      return url
    }
    throw failure("系统未返回已挂载的共享目录。")
  }
}
