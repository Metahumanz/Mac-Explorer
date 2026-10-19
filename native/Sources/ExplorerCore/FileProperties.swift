import Foundation
import Darwin

public struct FileProperties: Sendable {
  public let size: Int64
  public let allocated: Int64
  public let files: Int
  public let folders: Int
  public let skipped: Int
  public let symlinks: Int
  public let readOnly: Bool?
}

public enum FilePropertiesReader {
  public static func read(_ inputs: [URL]) throws -> FileProperties {
    try Task.checkCancellation()
    let paths = Array(Set(inputs.map { $0.standardizedFileURL.path }))
    guard !inputs.isEmpty, inputs.allSatisfy({ $0.isFileURL && ($0.host == nil || $0.host == "" || $0.host == "localhost") && $0.path.hasPrefix("/") && !$0.path.contains("\0") }) else { throw CocoaError(.fileReadInvalidFileName) }
    func info(_ path: String) throws -> stat {
      var value = stat()
      guard path.withCString({ Darwin.lstat($0, &value) }) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSFilePathErrorKey: path]) }
      return value
    }
    var directories = Set<String>()
    for path in paths { if try info(path).st_mode & S_IFMT == S_IFDIR { directories.insert(path) } }
    let roots = paths.filter { path in
      var ancestor = (path as NSString).deletingLastPathComponent
      while ancestor != path && !ancestor.isEmpty {
        if directories.contains(ancestor) { return false }
        if ancestor == "/" { break }
        ancestor = (ancestor as NSString).deletingLastPathComponent
      }
      return true
    }
    let rootSet = Set(roots)
    var queue = roots, seen = Set<String>(), size: Int64 = 0, allocated: Int64 = 0
    var files = 0, folders = 0, skipped = 0, symlinks = 0
    while let current = queue.popLast() {
      try Task.checkCancellation()
      let value: stat
      do { value = try info(current) } catch { if rootSet.contains(current) { throw error }; skipped += 1; continue }
      if value.st_mode & S_IFMT == S_IFDIR {
        if !rootSet.contains(current) { folders += 1 }
        do { queue += try FileManager.default.contentsOfDirectory(atPath: current).map { URL(fileURLWithPath: current).appendingPathComponent($0).path } }
        catch { skipped += 1 }
      } else {
        files += 1; size += value.st_size
        if value.st_mode & S_IFMT == S_IFLNK { symlinks += 1 }
        if seen.insert("\(value.st_dev):\(value.st_ino)").inserted { allocated += value.st_blocks * 512 }
      }
    }
    try Task.checkCancellation()
    let readOnly: Bool? = paths.count == 1 ? paths[0].withCString { Darwin.access($0, W_OK) != 0 } : nil
    return FileProperties(size: size, allocated: allocated, files: files, folders: folders, skipped: skipped, symlinks: symlinks, readOnly: readOnly)
  }
}
