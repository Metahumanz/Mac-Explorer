import Foundation
import Darwin

@main
struct PropertiesChecks {
  static func main() async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("ExplorerPropertiesChecks-\(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }
    let folder = root.appendingPathComponent("folder"), outside = root.appendingPathComponent("outside")
    try fm.createDirectory(at: folder.appendingPathComponent("nested"), withIntermediateDirectories: true)
    try fm.createDirectory(at: outside, withIntermediateDirectories: true)
    try Data("abc".utf8).write(to: folder.appendingPathComponent("file.txt"))
    try Data("hidden".utf8).write(to: folder.appendingPathComponent(".hidden"))
    try Data(repeating: 7, count: 8192).write(to: outside.appendingPathComponent("not-counted.bin"))
    try fm.linkItem(at: folder.appendingPathComponent("file.txt"), to: folder.appendingPathComponent("hardlink.txt"))
    try fm.createSymbolicLink(atPath: folder.appendingPathComponent("directory-link").path, withDestinationPath: "../outside")
    try fm.createSymbolicLink(atPath: folder.appendingPathComponent("broken-link").path, withDestinationPath: "missing")
    var count = 0
    func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
      guard try condition() else { throw NSError(domain: "PropertiesChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
      count += 1
    }
    let result = try FilePropertiesReader.read([folder])
    try check(result.files == 5, "Includes hidden files, hard links, and symlinks")
    try check(result.folders == 1, "Excludes selected root and does not recurse through directory symlink")
    try check(result.symlinks == 2 && result.skipped == 0, "Broken and directory links count as objects")
    try check(result.size == 3 + 3 + 6 + Int64("../outside".utf8.count) + Int64("missing".utf8.count), "Logical bytes exclude external target")
    let duplicate = try FilePropertiesReader.read([folder, folder, folder.appendingPathComponent("file.txt")])
    try check(duplicate.size == result.size && duplicate.files == result.files, "Selected ancestors and duplicate paths are counted once")
    let one = try FilePropertiesReader.read([folder.appendingPathComponent("file.txt")])
    let hardlinks = try FilePropertiesReader.read([folder.appendingPathComponent("file.txt"), folder.appendingPathComponent("hardlink.txt")])
    try check(hardlinks.size == one.size * 2, "Logical bytes count each selected hard link")
    try check(hardlinks.allocated == one.allocated, "Allocated bytes deduplicate hard-linked data")
    try check(one.files == 1 && one.folders == 0 && one.readOnly == false, "Single-file metadata")
    try check(hardlinks.readOnly == nil, "Multiple roots have no single read-only state")
    let onlyLink = try FilePropertiesReader.read([folder.appendingPathComponent("directory-link")])
    try check(onlyLink.files == 1 && onlyLink.folders == 0 && onlyLink.symlinks == 1, "Selected directory link is not traversed")
    for urls in [[], [URL(string: "https://invalid.example")!], [root.appendingPathComponent("missing")]] {
      var rejected = false
      do { _ = try FilePropertiesReader.read(urls) } catch { rejected = true }
      try check(rejected, "Invalid or missing roots are rejected")
    }
    let task = Task.detached { () throws -> FileProperties in
      withUnsafeCurrentTask { $0?.cancel() }
      return try FilePropertiesReader.read([folder])
    }
    var cancelled = false
    do { _ = try await task.value } catch is CancellationError { cancelled = true }
    try check(cancelled, "Properties traversal cooperates with cancellation")
    try check(try Data(contentsOf: folder.appendingPathComponent("file.txt")) == Data("abc".utf8), "Source payload preserved")
    try check(try Data(contentsOf: outside.appendingPathComponent("not-counted.bin")).count == 8192, "External target preserved")
    print("PropertiesChecks: \(count) assertions passed.")
  }
}
