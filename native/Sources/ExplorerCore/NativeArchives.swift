import Foundation

public struct NativeArchiveEntry: Codable, Hashable, Sendable {
  public let path: String
  public let directory: Bool
  public let size: Int64
}

public struct NativeArchivePreview: Sendable {
  public let url: URL
  public let entries: [NativeArchiveEntry]
}

public enum NativeArchives {
  private static let extensions = Set(["zip", "zipx", "7z", "rar", "tar", "tgz", "tbz", "tbz2", "txz", "gz", "bz2", "xz"])

  public static func isArchive(_ url: URL) -> Bool { extensions.contains(url.pathExtension.lowercased()) }

  public static func folderName(_ url: URL) -> String {
    let name = url.lastPathComponent.replacingOccurrences(of: "(?:\\.tar)?\\.(zip|zipx|7z|rar|tar|tgz|tbz2?|txz|gz|bz2|xz)$", with: "", options: .regularExpression.union(.caseInsensitive))
    return name.isEmpty ? NL("解压文件") : name
  }

  public static func preview(_ input: URL) throws -> NativeArchivePreview {
    let url = try absolute(input)
    guard isArchive(url), try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw failure("请选择压缩文件。") }
    let output = try native(["list", url.path], timeout: 15).output
    let entries = try output.split(separator: 10).map { try JSONDecoder().decode(NativeArchiveEntry.self, from: Data($0)) }
    return NativeArchivePreview(url: url, entries: entries)
  }

  public static func extract(_ input: URL, to destination: URL, selected: [String]? = nil, namedFolder: Bool = false) throws -> FileActionResult {
    let archive = try preview(input)
    if let selected {
      guard !selected.isEmpty, selected.count <= 10_000,
            selected.allSatisfy({ member in !member.isEmpty && !member.contains("\0") && archive.entries.contains(where: { $0.path == member || $0.path.hasPrefix(member + "/") }) }) else { throw failure("无效的压缩包项目选择，请重新打开预览。") }
    }
    let target = try absolute(destination).resolvingSymlinksInPath()
    guard try target.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw failure("请选择解压目标文件夹。") }
    let staging = try temporary(in: target, prefix: ".explorer-extract-")
    defer { try? FileManager.default.removeItem(at: staging) }
    // Decode completely before publishing so corrupt data never becomes visible at the destination.
    _ = try native(["extract", archive.url.path, staging.path] + (selected ?? []), timeout: 300)
    let names = namedFolder ? [folderName(archive.url)] : try FileManager.default.contentsOfDirectory(atPath: staging.path).sorted()
    var succeeded: [URL] = [], errors: [String] = [], changes: [FileActionChange] = []
    for name in names {
      try validateName(name)
      let output = target.appendingPathComponent(name)
      do {
        _ = try native(["publish", namedFolder ? staging.path : staging.appendingPathComponent(name).path, output.path])
        succeeded.append(output)
        changes.append(FileActionChange(source: nil, destination: output, kind: .create))
      } catch {
        errors.append("\(output.path)：\(exists(output) ? NL("同名项目已存在，已跳过并保留原内容。") : error.localizedDescription)")
      }
    }
    return FileActionResult(succeeded: succeeded, errors: errors, changes: changes)
  }

  public static func prepareFile(_ input: URL, member: String) throws -> (directory: URL, file: URL) {
    let archive = try preview(input)
    guard archive.entries.contains(where: { $0.path == member && !$0.directory }) else { throw failure("请选择压缩包内的文件。") }
    let directory = try temporary(in: FileManager.default.temporaryDirectory, prefix: "mac-explorer-open-")
    do {
      _ = try native(["extract", archive.url.path, directory.path, member], timeout: 300)
      let file = directory.appendingPathComponent(member)
      let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
      guard values.isRegularFile == true, values.isSymbolicLink != true else { throw failure("无法打开此压缩包项目。") }
      _ = try native(["quarantine", archive.url.path, file.path])
      return (directory, file)
    } catch { try? FileManager.default.removeItem(at: directory); throw error }
  }

  public static func compress(_ inputs: [URL]) throws -> URL {
    guard !inputs.isEmpty, inputs.count <= 10_000 else { throw failure("请先选择要压缩的文件或文件夹。") }
    var candidates: [URL] = []
    for input in inputs {
      let url = try absolute(input)
      if !candidates.contains(url) { candidates.append(url) }
    }
    let sources = candidates.filter { item in !candidates.contains(where: { $0 != item && item.path.hasPrefix($0.path + "/") }) }
    for source in sources {
      guard source.path != "/" else { throw failure("不能压缩整个磁盘。") }
      let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
      guard values.isSymbolicLink != true, values.isRegularFile == true || values.isDirectory == true else { throw failure("暂不支持压缩链接或特殊文件。") }
    }
    var base = sources[0].deletingLastPathComponent()
    while !sources.allSatisfy({ base.path == "/" || $0.path.hasPrefix(base.path + "/") }) { base.deleteLastPathComponent() }
    let parent = base.resolvingSymlinksInPath()
    let singleDirectory = try sources.count == 1 && sources[0].resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true
    let stem = sources.count == 1 ? (singleDirectory ? sources[0].lastPathComponent : sources[0].deletingPathExtension().lastPathComponent) : NL("压缩文件")
    try validateName(stem + ".zip")
    let staging = try temporary(in: parent, prefix: ".explorer-compress-")
    defer { try? FileManager.default.removeItem(at: staging) }
    let archive = staging.appendingPathComponent("output.zip")
    let relative = sources.map { "./" + String($0.path.dropFirst(base.path == "/" ? 1 : base.path.count + 1)) }
    let result = try NativeCommand.run(executable: "/usr/bin/tar", arguments: ["-c", "--format", "zip", "--no-mac-metadata", "-f", archive.path, "-C", base.path] + relative, timeout: 300, limit: 1024 * 1024)
    guard result.error.isEmpty else { throw failure(NL("压缩未完成：{0}", result.errorText)) }
    _ = try preview(archive)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: archive.path)
    for index in 1...10_000 {
      let output = parent.appendingPathComponent("\(stem)\(index == 1 ? "" : " (\(index))").zip")
      do { _ = try native(["publish", archive.path, output.path]); return output }
      catch { if !exists(output) { throw error } }
    }
    throw failure("同名压缩包过多，请先重命名部分文件。")
  }

  private static func native(_ arguments: [String], timeout: TimeInterval = 15) throws -> NativeCommandResult {
    let helper = ProcessInfo.processInfo.environment["MAC_EXPLORER_ARCHIVE_READER"] ?? Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/archive-reader").path
    do { return try NativeCommand.run(executable: helper, arguments: arguments, timeout: timeout, limit: 4 * 1024 * 1024) }
    catch { throw failure(error.localizedDescription) }
  }

  private static func absolute(_ url: URL) throws -> URL {
    guard url.isFileURL, url.path.hasPrefix("/"), !url.path.contains("\0"),
          url.host == nil || url.host == "" || url.host == "localhost", url.query == nil, url.fragment == nil else { throw failure("无效的文件路径。") }
    return url.standardizedFileURL
  }

  private static func temporary(in parent: URL, prefix: String) throws -> URL {
    let url = parent.appendingPathComponent(prefix + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    return url
  }

  private static func exists(_ url: URL) -> Bool { (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) != nil || FileManager.default.fileExists(atPath: url.path) }
  private static func validateName(_ name: String) throws {
    guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains(":"), !name.contains("\0"), name.utf8.count <= 255 else { throw failure("无效的文件名。") }
  }
  private static func failure(_ message: String) -> NSError { NSError(domain: "MacExplorer.Archive", code: 1, userInfo: [NSLocalizedDescriptionKey: NL(message)]) }
}
