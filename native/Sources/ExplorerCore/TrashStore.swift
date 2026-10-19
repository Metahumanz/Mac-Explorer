import Foundation
import CryptoKit
import Darwin

public struct TrashItemSnapshot: Codable, Sendable {
  public let path: String
  public let identity: String
  public let parentIdentity: String
}
public struct TrashStore: Sendable {
  public let roots: [URL]
  public let records: URL
  private struct Origin: Codable {
    let path: String
    let identity: String
    let rootPath: String
    let rootIdentity: String
    let originalParentPath: String
    let originalParentIdentity: String?
  }
  public init(roots: [URL], records: URL) { self.roots = roots; self.records = records }
  private func record(_ url: URL) -> URL {
    records.appendingPathComponent(SHA256.hash(data: Data(url.path.utf8)).map { String(format: "%02x", $0) }.joined() + ".json")
  }
  public static func identity(_ url: URL) throws -> String { try FileActions.identity(url) }
  private func local(_ input: URL) throws -> URL {
    guard input.isFileURL, input.baseURL == nil, input.user == nil, input.password == nil, input.port == nil, input.path.hasPrefix("/"), !input.path.contains("\0"), input.query == nil, input.fragment == nil, input.host == nil || input.host == "" || input.host == "localhost" else { throw failure(NL("只能操作回收站内的项目。")) }
    let url = input.standardizedFileURL
    guard url.path != "/" else { throw failure(NL("只能操作回收站内的项目。")) }
    // Canonicalize parents only: the final component may be a dangling symlink object.
    let parent = url.deletingLastPathComponent()
    if let resolved = parent.path.withCString({ Darwin.realpath($0, nil) }) {
      defer { free(resolved) }
      return URL(fileURLWithPath: String(cString: resolved)).appendingPathComponent(url.lastPathComponent)
    }
    if errno == ENOENT { return url }
    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSFilePathErrorKey: parent.path])
  }
  private func realPath(_ url: URL) throws -> String {
    guard let resolved = url.path.withCString({ Darwin.realpath($0, nil) }) else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSFilePathErrorKey: url.path]) }
    defer { free(resolved) }
    return String(cString: resolved)
  }
  private func info(_ url: URL) throws -> stat? {
    var value = stat()
    if url.path.withCString({ Darwin.lstat($0, &value) }) == 0 { return value }
    if errno == ENOENT { return nil }
    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSFilePathErrorKey: url.path])
  }
  private func inside(_ root: String, _ path: String) -> Bool { path == root || path.hasPrefix(root + "/") }
  private func root(for url: URL, directory: Bool = false) throws -> URL {
    let candidates = roots.compactMap { try? local($0) }.filter { url.path.hasPrefix($0.path + "/") || directory && url.path == $0.path }.sorted { $0.path.count > $1.path.count }
    guard let root = candidates.first else { throw failure(NL("只能操作回收站内的项目。")) }
    guard let value = try info(root) else { throw CocoaError(.fileReadNoSuchFile, userInfo: [NSFilePathErrorKey: root.path]) }
    guard value.st_mode & S_IFMT != S_IFLNK else { throw failure(NL("回收站根目录不能是符号链接。")) }
    guard value.st_mode & S_IFMT == S_IFDIR else { throw CocoaError(.fileReadUnknown, userInfo: [NSFilePathErrorKey: root.path]) }
    return root
  }
  public func validate(_ input: URL, directory: Bool = false) throws -> URL {
    let url = try local(input), root = try root(for: url, directory: directory)
    let resolvedRoot = try realPath(root)
    let parent = try realPath(directory ? url : url.deletingLastPathComponent())
    guard inside(resolvedRoot, parent) else { throw failure(NL("不能操作指向回收站外部的路径。")) }
    return url
  }
  public func remember(_ trashed: URL, original: URL) throws {
    let trashed = try validate(trashed), original = try local(original), root = try root(for: trashed)
    let parent = original.deletingLastPathComponent()
    let records = try local(records)
    try FileManager.default.createDirectory(at: records, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    guard let value = try info(records), value.st_mode & S_IFMT == S_IFDIR else { throw failure(NL("来源记录目录无效。")) }
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: records.path)
    let destination = record(trashed)
    if let value = try info(destination), value.st_mode & S_IFMT != S_IFREG { throw failure(NL("来源记录无效。")) }
    let origin = Origin(path: original.path, identity: try Self.identity(trashed), rootPath: root.path, rootIdentity: try Self.identity(root), originalParentPath: parent.path, originalParentIdentity: try? Self.identity(parent))
    try JSONEncoder().encode(origin).write(to: destination, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
  }
  private func origin(_ input: URL) -> Origin? {
    guard let url = try? validate(input), let root = try? root(for: url), let records = try? local(records),
      let recordRoot = try? info(records), recordRoot.st_mode & S_IFMT == S_IFDIR,
      let metadata = try? info(record(url)), metadata.st_mode & S_IFMT == S_IFREG, metadata.st_size <= 16_384,
      let data = try? Data(contentsOf: record(url)), let origin = try? JSONDecoder().decode(Origin.self, from: data),
      origin.identity == (try? Self.identity(url)), origin.rootPath == root.path, origin.rootIdentity == (try? Self.identity(root)),
      let original = try? local(URL(fileURLWithPath: origin.path)), original.path == origin.path else { return nil }
    return origin
  }
  public func original(_ trashed: URL) -> URL? { origin(trashed).map { URL(fileURLWithPath: $0.path) } }
  public func list(_ directory: URL? = nil) throws -> DirectorySnapshot {
    if let directory { return try DirectoryReader.read(validate(directory, directory: true)) }
    var entries: [FileEntry] = [], skipped = 0, seen: Set<String> = []
    for input in roots {
      do {
        let root = try local(input)
        if !seen.insert(root.path).inserted { continue }
        if try info(root) == nil { continue }
        let result = try DirectoryReader.read(validate(root, directory: true))
        entries += result.entries; skipped += result.skippedCount
      } catch { skipped += 1 }
    }
    return DirectorySnapshot(directory: URL(string: "explorer://trash")!, entries: entries, skippedCount: skipped, elapsedMilliseconds: 0)
  }
  public func snapshot() throws -> [TrashItemSnapshot] {
    var result: [TrashItemSnapshot] = [], seen: Set<String> = []
    for input in roots {
      do {
        let root = try local(input)
        if !seen.insert(root.path).inserted { continue }
        if try info(root) == nil { continue }
        _ = try validate(root, directory: true)
        let parent = try Self.identity(root)
        for name in try FileManager.default.contentsOfDirectory(atPath: root.path) {
          let url = try validate(root.appendingPathComponent(name))
          result.append(TrashItemSnapshot(path: url.path, identity: try Self.identity(url), parentIdentity: parent))
        }
        guard try Self.identity(root) == parent else { throw failure(NL("项目已发生变化，已跳过；请刷新后重试。")) }
      } catch { throw failure(NL("部分回收站无法读取，请检查访问权限后再清空。") + "\n" + input.path + "：" + error.localizedDescription) }
    }
    return result
  }
  public func empty(_ snapshot: [TrashItemSnapshot]) -> FileActionResult {
    var succeeded: [URL] = [], errors: [String] = [], seen: Set<String> = []
    for item in snapshot {
      do {
        let url = try validate(URL(fileURLWithPath: item.path)), parent = url.deletingLastPathComponent()
        guard seen.insert(url.path).inserted else { continue }
        guard try roots.map(local).contains(where: { $0.path == parent.path }) else { throw failure(NL("只能清理回收站顶层项目。")) }
        guard try Self.identity(url) == item.identity, try Self.identity(parent) == item.parentIdentity else { throw failure(NL("项目已发生变化，已跳过；请刷新后重试。")) }
        // removeItem unlinks symlink objects; descendants of a confirmed folder belong to that item.
        try FileManager.default.removeItem(at: url)
        try? FileManager.default.removeItem(at: record(url)); succeeded.append(url)
      } catch { errors.append("\(item.path)：\(error.localizedDescription)") }
    }
    return FileActionResult(succeeded: succeeded, errors: errors, changes: [])
  }
  public func restore(_ inputs: [URL], to directory: URL? = nil) -> FileActionResult {
    var succeeded: [URL] = [], errors: [String] = [], unique: [URL] = []
    for input in inputs {
      do { let url = try validate(input); if !unique.contains(where: { $0.path == url.path }) { unique.append(url) } }
      catch { errors.append("\(input.path)：\(error.localizedDescription)") }
    }
    for url in unique where !unique.contains(where: { $0.path != url.path && url.path.hasPrefix($0.path + "/") }) {
      do {
        let origin = origin(url), original = origin.map { URL(fileURLWithPath: $0.path) }
        guard let target = try directory.map({ try local($0).appendingPathComponent(original?.lastPathComponent ?? url.lastPathComponent) }) ?? original else { throw failure(NL("无法确定原位置，请使用“还原到…”选择文件夹。")) }
        let parent = URL(fileURLWithPath: try realPath(target.deletingLastPathComponent()))
        if directory == nil {
          guard let origin, let expected = origin.originalParentIdentity, origin.originalParentPath == parent.path, try Self.identity(parent) == expected else { throw failure(NL("原位置已发生变化，请使用“还原到…”选择文件夹。")) }
        }
        guard try !roots.map(local).contains(where: { inside((try? realPath($0)) ?? $0.path, parent.path) }) else { throw failure(NL("请选择回收站之外的还原位置。")) }
        let change = FileActionChange(source: target, destination: url, kind: .trash)
        if let origin { guard change.destinationIdentity == origin.identity else { throw failure(NL("项目已发生变化，已跳过；请刷新后重试。")) } }
        let result = FileActions.undo([change])
        if result.errors.isEmpty { try? FileManager.default.removeItem(at: record(url)); succeeded.append(url) }
        errors += result.errors
      } catch { errors.append("\(url.path)：\(error.localizedDescription)") }
    }
    return FileActionResult(succeeded: succeeded, errors: errors, changes: [])
  }
  private func failure(_ text: String) -> NSError { NSError(domain: "NativeTrash", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}
