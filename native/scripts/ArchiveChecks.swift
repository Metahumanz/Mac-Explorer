import Foundation

@main
enum ArchiveChecks {
  static func main() throws {
    let fm = FileManager.default
    let root = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath()
    func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
      guard try condition() else { throw NSError(domain: "ArchiveChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    func rejects(_ label: String, _ operation: () throws -> Void) throws {
      do { try operation() } catch { return }
      throw NSError(domain: "ArchiveChecks", code: 2, userInfo: [NSLocalizedDescriptionKey: "Expected rejection: \(label)"])
    }
    func folder(_ name: String) throws -> URL {
      let url = root.appendingPathComponent(name); try fm.createDirectory(at: url, withIntermediateDirectories: true); return url
    }
    let sources = try folder("sources")
    let nested = sources.appendingPathComponent("资料 目录", isDirectory: true)
    try fm.createDirectory(at: nested, withIntermediateDirectories: true)
    let document = nested.appendingPathComponent("报价 ' $ (一).txt")
    let content = Data("archive source preserved ✓".utf8)
    try content.write(to: document)
    try Data("hidden".utf8).write(to: nested.appendingPathComponent(".hidden"))
    let empty = nested.appendingPathComponent("empty", isDirectory: true)
    try fm.createDirectory(at: empty, withIntermediateDirectories: false)
    let archive = try NativeArchives.compress([nested, document, nested])
    try check(archive.lastPathComponent == "资料 目录.zip", "compression name")
    let again = try NativeArchives.compress([nested])
    try check(again.lastPathComponent == "资料 目录 (2).zip", "compression collisions are exclusive")
    try check(try Data(contentsOf: document) == content, "source preservation")
    let preview = try NativeArchives.preview(archive)
    let member = "资料 目录/" + document.lastPathComponent
    try check(preview.entries.contains(where: { $0.path == member && !$0.directory }), "unicode member listing")
    let destination = try folder("extracted")
    let extraction = try NativeArchives.extract(archive, to: destination)
    try check(extraction.errors.isEmpty && extraction.succeeded.count == 1 && extraction.changes.count == 1, "extraction creates undo records")
    try check(try Data(contentsOf: destination.appendingPathComponent(member)) == content, "extraction contents")
    let collision = try NativeArchives.extract(archive, to: destination)
    try check(collision.succeeded.isEmpty && collision.errors.count == 1, "existing folder is not merged or overwritten")
    try check(try Data(contentsOf: destination.appendingPathComponent(member)) == content, "collision preserves destination")
    let selectionTarget = try folder("selection")
    let selection = try NativeArchives.extract(archive, to: selectionTarget, selected: [member])
    try check(selection.errors.isEmpty, "selected extraction succeeds")
    try check(!fm.fileExists(atPath: selectionTarget.appendingPathComponent("资料 目录/.hidden").path), "unselected file absent")
    let partialTarget = try folder("partial")
    try content.write(to: partialTarget.appendingPathComponent("keep.txt"))
    let partial = try NativeArchives.extract(root.appendingPathComponent("partial.zip"), to: partialTarget)
    try check(partial.errors.count == 1 && partial.succeeded.count == 1 && partial.changes.count == 1, "partial collisions report successes and failures")
    try check(try Data(contentsOf: partialTarget.appendingPathComponent("keep.txt")) == content, "partial collision preserves prior bytes")
    try check(try Data(contentsOf: partialTarget.appendingPathComponent("new.txt")) == Data("new".utf8), "nonconflicting root publishes")
    let namedTarget = try folder("named")
    let named = try NativeArchives.extract(archive, to: namedTarget, selected: [member], namedFolder: true)
    try check(named.succeeded.first?.lastPathComponent == "资料 目录", "named folder")
    let againNamed = try NativeArchives.extract(archive, to: namedTarget, namedFolder: true)
    try check(againNamed.succeeded.isEmpty && againNamed.errors.count == 1, "named collision")
    let prepared = try NativeArchives.prepareFile(archive, member: member)
    defer { try? fm.removeItem(at: prepared.directory) }
    try check(try Data(contentsOf: prepared.file) == content, "temporary opening bytes")
    _ = try NativeCommand.run(executable: "/usr/bin/xattr", arguments: ["-w", "com.apple.quarantine", "0081;00000000;ArchiveChecks;", archive.path])
    let quarantined = try NativeArchives.prepareFile(archive, member: member)
    defer { try? fm.removeItem(at: quarantined.directory) }
    let attribute = try NativeCommand.run(executable: "/usr/bin/xattr", arguments: ["-p", "com.apple.quarantine", quarantined.file.path])
    try check(attribute.text.contains("ArchiveChecks"), "quarantine preserved")
    try rejects("empty selection") { _ = try NativeArchives.extract(archive, to: destination, selected: []) }
    try rejects("empty compression") { _ = try NativeArchives.compress([]) }
    try rejects("root compression") { _ = try NativeArchives.compress([URL(fileURLWithPath: "/")]) }
    try rejects("non-file URL") { _ = try NativeArchives.preview(URL(string: "https://example.com/archive.zip")!) }
    try rejects("invalid selection") { _ = try NativeArchives.extract(archive, to: destination, selected: ["../escape"]) }
    try rejects("non-member opening") { _ = try NativeArchives.prepareFile(archive, member: "../escape") }
    try rejects("directory opening") { _ = try NativeArchives.prepareFile(archive, member: "资料 目录") }
    for name in ["traversal.zip", "absolute.zip", "backslash.zip", "colon.zip", "symlink.zip", "corrupt.zip", "too-many.zip", "too-large.tar"] {
      let bad = root.appendingPathComponent(name)
      try rejects(name) { _ = try NativeArchives.extract(bad, to: destination) }
    }
    try rejects("duplicate extraction") { _ = try NativeArchives.extract(root.appendingPathComponent("duplicate.zip"), to: destination) }
    try check(!fm.fileExists(atPath: destination.appendingPathComponent("duplicate.txt").path), "failed decode publishes no partial output")
    try check(!fm.fileExists(atPath: root.appendingPathComponent("escape").path), "path traversal rejected")
    let dangling = destination.appendingPathComponent("资料 目录", isDirectory: true)
    try fm.removeItem(at: dangling)
    try fm.createSymbolicLink(at: dangling, withDestinationURL: root.appendingPathComponent("does-not-exist"))
    let linkCollision = try NativeArchives.extract(archive, to: destination)
    try check(linkCollision.succeeded.isEmpty && linkCollision.errors.count == 1, "dangling symlink collision")
    try check(try fm.destinationOfSymbolicLink(atPath: dangling.path) == root.appendingPathComponent("does-not-exist").path, "symlink preserved")
    let sourceLink = sources.appendingPathComponent("link")
    try fm.createSymbolicLink(at: sourceLink, withDestinationURL: document)
    try rejects("symlink compression") { _ = try NativeArchives.compress([sourceLink]) }
    try fm.createSymbolicLink(at: nested.appendingPathComponent("nested-link"), withDestinationURL: document)
    try rejects("nested symlink compression") { _ = try NativeArchives.compress([nested]) }
    try check(!fm.fileExists(atPath: sources.appendingPathComponent("资料 目录 (3).zip").path), "unsupported links do not publish archives")
    for target in [sources, destination, selectionTarget, namedTarget, partialTarget] {
      try check(try fm.contentsOfDirectory(atPath: target.path).allSatisfy { !$0.hasPrefix(".explorer-") }, "staging cleanup")
    }
    try check(try Data(contentsOf: document) == content, "all operations preserve source")
    try check(NativeArchives.folderName(URL(fileURLWithPath: "/test/test.tar.gz")) == "test", "compound extension")
    try check(NativeArchives.isArchive(URL(fileURLWithPath: "/test/test.ZIP")), "case insensitive extension")
    print("Archive checks passed: compression, browsing, selection, quarantine, collisions, unsafe paths, links, corruption, limits, source preservation.")
  }
}
