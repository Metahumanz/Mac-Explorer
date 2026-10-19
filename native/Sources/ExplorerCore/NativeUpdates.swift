import Foundation
import CoreFoundation

public struct NativeRelease: Equatable, Sendable {
  public let version: String
  public let archive: String
  public let bytes: Int64
  public var base: String { "https://github.com/qixiaoyu27/Mac-Explorer/releases/download/v\(version)" }
}
public struct NativeUpdateState: Sendable {
  public init(currentVersion: String) { self.currentVersion = currentVersion }
  public var status = "idle"
  public var currentVersion: String
  public var latestVersion: String?
  public var downloaded: Int64 = 0
  public var total: Int64 = 0
  public var error = ""
}
public enum NativeUpdateValidation {
  public static let bundleID = "local.macexplorer.native-prototype"
  public static let appName = "Mac Explorer Native.app"
  public static let checksumName = "SHA256SUMS-native.txt"
  public static func failure(_ message: String) -> NSError { NSError(domain: "MacExplorer.NativeUpdate", code: 1, userInfo: [NSLocalizedDescriptionKey: NL(message)]) }
  public static func compare(_ left: String, _ right: String) throws -> Int {
    let pattern = #"^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$"#
    guard [left, right].allSatisfy({ $0.range(of: pattern, options: .regularExpression) != nil }) else { throw failure("无法识别应用版本。") }
    for (a, b) in zip(left.split(separator: ".").map { Int($0)! }, right.split(separator: ".").map { Int($0)! }) { if a != b { return a < b ? -1 : 1 } }
    return 0
  }
  public static func release(_ data: Data) throws -> NativeRelease {
    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], json["draft"] as? Bool == false, json["prerelease"] as? Bool == false,
      let tag = json["tag_name"] as? String, tag.hasPrefix("v"), let assets = json["assets"] as? [[String: Any]] else { throw failure("最新发布信息不完整，请稍后重试。") }
    let version = String(tag.dropFirst()); _ = try compare(version, version)
    let archive = "Mac-Explorer-Native-\(version)-mac-arm64.zip"
    let base = "https://github.com/qixiaoyu27/Mac-Explorer/releases/download/v\(version)"
    for name in [archive, checksumName] {
      let matches = assets.filter { $0["name"] as? String == name }
      guard matches.count == 1, matches[0]["browser_download_url"] as? String == "\(base)/\(name)" else { throw failure("尚无可用的原生版本更新。") }
    }
    let size = assets.first { $0["name"] as? String == archive }?["size"] as? NSNumber
    guard let size, CFGetTypeID(size) != CFBooleanGetTypeID(), size.doubleValue == Double(size.int64Value), size.int64Value > 0, size.int64Value <= 2 * 1024 * 1024 * 1024 else { throw failure("更新包大小无效。") }
    return NativeRelease(version: version, archive: archive, bytes: size.int64Value)
  }
  public static func checksum(_ text: String, archive: String) throws -> String {
    let matches = text.components(separatedBy: .newlines).map { $0.split(whereSeparator: \.isWhitespace).map(String.init) }.filter { $0.count == 2 && $0[1] == archive }
    guard matches.count == 1, matches[0][0].range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil else { throw failure("更新校验文件无效。") }
    return matches[0][0].lowercased()
  }
  public static func validateApp(_ app: URL, version: String? = nil) throws {
    let fm = FileManager.default
    guard app.lastPathComponent == appName, app.resolvingSymlinksInPath().path == app.standardizedFileURL.path,
      let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any],
      info["CFBundleIdentifier"] as? String == bundleID, info["CFBundleExecutable"] as? String == "MacExplorerNative",
      let actualVersion = info["CFBundleShortVersionString"] as? String,
      version == nil || actualVersion == version, fm.isExecutableFile(atPath: app.appendingPathComponent("Contents/MacOS/MacExplorerNative").path) else { throw failure("更新应用标识或版本不匹配。") }
    _ = try compare(actualVersion, actualVersion)
    _ = try NativeCommand.run(executable: "/usr/bin/lipo", arguments: [app.appendingPathComponent("Contents/MacOS/MacExplorerNative").path, "-verify_arch", "arm64"])
    _ = try NativeCommand.run(executable: "/usr/bin/codesign", arguments: ["--verify", "--deep", "--strict", app.path], timeout: 120)
  }
  public static func validateArchive(_ archive: URL) throws {
    let listing = try NativeCommand.run(executable: "/usr/bin/unzip", arguments: ["-Z", "-1", archive.path]).text
    let entries = listing.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    guard !entries.isEmpty, entries.count <= 100_000, entries.allSatisfy({ name in
      let parts = name.split(separator: "/", omittingEmptySubsequences: false)
      return (name == appName + "/" || name.hasPrefix(appName + "/")) && !name.contains("\\") && !name.contains("\r") && !name.contains("\0") && !parts.contains("..") && !parts.contains(".")
    }) else { throw failure("更新压缩包路径无效。") }
    let summary = try NativeCommand.run(executable: "/usr/bin/unzip", arguments: ["-Z", "-t", archive.path], environment: ["LC_ALL": "C"]).text.split(whereSeparator: \.isWhitespace)
    guard summary.count >= 5, let bytes = Int64(summary[2]), bytes >= 0, bytes <= 2 * 1024 * 1024 * 1024, summary[4] == "uncompressed," else { throw failure("更新压缩包展开大小无效。") }
    let attributes = try NativeCommand.run(executable: "/usr/bin/unzip", arguments: ["-Z", "-l", archive.path]).text
    guard !attributes.components(separatedBy: .newlines).contains(where: { $0.hasPrefix("l") }) else { throw failure("更新压缩包包含符号链接。") }
  }
}

public actor NativeUpdates {
  public private(set) var state: NativeUpdateState
  private var selected: NativeRelease?
  private var directory: URL?
  private var busy = false
  private let app: URL
  private let cache: URL
  private let session: URLSession
  public init(version: String, app: URL, cache: URL, session: URLSession = .shared) {
    state = NativeUpdateState(currentVersion: version); self.app = app; self.cache = cache; self.session = session
    if let result = try? String(contentsOf: cache.appendingPathComponent("last-install-result"), encoding: .utf8), result.trimmingCharacters(in: .whitespacesAndNewlines) != "0" { state.error = NL("上次更新未完成，请重试。") }
  }
  private func request(_ url: String, maximum: Int64, destination: URL? = nil) async throws -> Data {
    var request = URLRequest(url: URL(string: url)!); request.timeoutInterval = destination == nil ? 30 : 900
    request.setValue("Mac-Explorer-Native", forHTTPHeaderField: "User-Agent"); request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    let (bytes, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200, response.url?.scheme == "https" else { throw NativeUpdateValidation.failure("无法连接更新服务。") }
    guard response.expectedContentLength <= maximum else { throw NativeUpdateValidation.failure("更新服务响应过大。") }
    var data = Data(), count: Int64 = 0
    let file: FileHandle?
    if let destination {
      guard FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
      file = try FileHandle(forWritingTo: destination)
    } else { file = nil }
    defer { try? file?.close() }
    for try await byte in bytes {
      try Task.checkCancellation(); count += 1
      guard count <= maximum else { throw NativeUpdateValidation.failure("更新服务响应过大。") }
      data.append(byte)
      if file != nil, data.count >= 65536 { try file?.write(contentsOf: data); data.removeAll(keepingCapacity: true); state.downloaded = count }
    }
    if let file { try file.write(contentsOf: data); state.downloaded = count; return Data() }
    return data
  }
  public func check() async {
    guard !busy, state.status != "ready", state.status != "installing" else { return }
    busy = true; defer { busy = false }; state.status = "checking"; state.error = ""; selected = nil
    do {
      // The latest release may still contain only Electron assets; select a stable Native release explicitly.
      let response = try await request("https://api.github.com/repos/qixiaoyu27/Mac-Explorer/releases?per_page=100", maximum: 4 * 1024 * 1024)
      guard let releases = try JSONSerialization.jsonObject(with: response) as? [[String: Any]] else { throw NativeUpdateValidation.failure("最新发布信息不完整，请稍后重试。") }
      let compatible = releases.compactMap { value -> NativeRelease? in guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }; return try? NativeUpdateValidation.release(data) }
      guard let latest = compatible.max(by: { (try? NativeUpdateValidation.compare($0.version, $1.version)) == -1 }) else { throw NativeUpdateValidation.failure("尚无可用的原生版本更新。") }
      selected = latest; state.latestVersion = latest.version; state.total = latest.bytes; state.downloaded = 0
      state.status = try NativeUpdateValidation.compare(latest.version, state.currentVersion) > 0 ? "available" : "current"
      if let last = try? String(contentsOf: cache.appendingPathComponent("last-install-result"), encoding: .utf8), last.trimmingCharacters(in: .whitespacesAndNewlines) != "0" { state.error = NL("上次更新未完成，请重试。") }
    } catch { state.status = "error"; state.error = error.localizedDescription }
  }
  public func download() async {
    guard !busy, state.status == "available", let release = selected else { return }
    busy = true; defer { busy = false }; state.error = ""; state.status = "downloading"; state.downloaded = 0
    var work: URL?
    do {
      try NativeUpdateValidation.validateApp(app)
      guard !app.path.hasPrefix("/Volumes/"), FileManager.default.isWritableFile(atPath: app.deletingLastPathComponent().path) else { throw NativeUpdateValidation.failure("请将应用移到可写的应用程序目录后更新。") }
      try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let folder = cache.appendingPathComponent("download-" + UUID().uuidString); work = folder
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
      let sums = try await request(release.base + "/" + NativeUpdateValidation.checksumName, maximum: 1024 * 1024)
      let expected = try NativeUpdateValidation.checksum(String(decoding: sums, as: UTF8.self), archive: release.archive)
      let archive = folder.appendingPathComponent(release.archive)
      _ = try await request(release.base + "/" + release.archive, maximum: release.bytes, destination: archive)
      guard state.downloaded == release.bytes else { throw NativeUpdateValidation.failure("更新包大小不一致，请重新下载。") }
      state.status = "verifying"
      let hash = try NativeCommand.run(executable: "/usr/bin/shasum", arguments: ["-a", "256", archive.path]).text.split(separator: " ").first.map(String.init)
      guard hash == expected else { throw NativeUpdateValidation.failure("更新包校验失败，请重新下载。") }
      try NativeUpdateValidation.validateArchive(archive)
      let verify = folder.appendingPathComponent("verify")
      _ = try NativeCommand.run(executable: "/usr/bin/ditto", arguments: ["-x", "-k", archive.path, verify.path], timeout: 300)
      try NativeUpdateValidation.validateApp(verify.appendingPathComponent(NativeUpdateValidation.appName), version: release.version)
      try FileManager.default.removeItem(at: verify)
      try Data("\(expected)  \(release.archive)\n".utf8).write(to: folder.appendingPathComponent(NativeUpdateValidation.checksumName), options: .atomic)
      for name in ["install-native.sh", "update-native.sh"] {
        try FileManager.default.copyItem(at: app.appendingPathComponent("Contents/Resources/" + name), to: folder.appendingPathComponent(name))
      }
      directory = folder; state.status = "ready"
    } catch { if let work { try? FileManager.default.removeItem(at: work) }; state.status = "error"; state.error = error.localizedDescription }
  }
  public func installer() throws -> NativeUpdateInstaller {
    guard !busy, state.status == "ready", let directory else { throw NativeUpdateValidation.failure("请先完成更新下载。") }
    try NativeUpdateValidation.validateApp(app)
    return NativeUpdateInstaller(directory: directory, app: app, cache: cache)
  }
}

// Created after download verification; launch only after the app accepts termination and saves its windows.
public struct NativeUpdateInstaller: Sendable {
  private let directory: URL
  private let app: URL
  private let cache: URL
  init(directory: URL, app: URL, cache: URL) { self.directory = directory; self.app = app; self.cache = cache }
  public func launch(pid: Int32) throws {
    guard pid > 0 else { throw NativeUpdateValidation.failure("无效的更新进程。") }
    try NativeUpdateValidation.validateApp(app)
    let process = Process(); process.executableURL = URL(fileURLWithPath: "/bin/bash"); process.arguments = [directory.appendingPathComponent("update-native.sh").path]
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(), "MAC_EXPLORER_NATIVE_PREPARED": directory.path, "MAC_EXPLORER_NATIVE_INSTALL_DIR": app.deletingLastPathComponent().path, "MAC_EXPLORER_NATIVE_WAIT_PID": String(pid), "MAC_EXPLORER_NATIVE_RESULT": cache.appendingPathComponent("last-install-result").path]
    let log = directory.appendingPathComponent("install.log"); FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
    let handle = try FileHandle(forWritingTo: log); defer { try? handle.close() }
    process.standardInput = FileHandle.nullDevice; process.standardOutput = handle; process.standardError = handle
    try process.run()
  }
}
