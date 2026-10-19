import Foundation
import XCTest
@testable import ExplorerCore

final class DirectoryReaderTests: XCTestCase {
  private var root: URL!
  private let manager = FileManager.default

  override func setUpWithError() throws {
    root = manager.temporaryDirectory.appendingPathComponent("ExplorerCoreTests-\(UUID().uuidString)")
    try manager.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    if let root { try manager.removeItem(at: root) }
    root = nil
  }

  func testMetadataHiddenFilesAndNonrecursiveEnumeration() throws {
    let content = Data("hello explorer".utf8)
    let file = root.appendingPathComponent("notes.txt")
    try content.write(to: file)
    let modified = Date(timeIntervalSince1970: 1_700_000_000)
    try manager.setAttributes([.modificationDate: modified], ofItemAtPath: file.path)
    try Data("secret".utf8).write(to: root.appendingPathComponent(".hidden"))
    let folder = root.appendingPathComponent("folder")
    try manager.createDirectory(at: folder, withIntermediateDirectories: true)
    try content.write(to: folder.appendingPathComponent("nested.txt"))
    let package = root.appendingPathComponent("Example.app")
    try manager.createDirectory(at: package, withIntermediateDirectories: true)

    let snapshot = try DirectoryReader.read(root)
    let entries = Dictionary(uniqueKeysWithValues: snapshot.entries.map { ($0.name, $0) })
    XCTAssertEqual(snapshot.directory, root)
    XCTAssertEqual(Set(entries.keys), ["notes.txt", ".hidden", "folder", "Example.app"])
    XCTAssertEqual(snapshot.skippedCount, 0)
    XCTAssertTrue(snapshot.elapsedMilliseconds.isFinite)
    XCTAssertGreaterThanOrEqual(snapshot.elapsedMilliseconds, 0)

    let notes = try XCTUnwrap(entries["notes.txt"])
    XCTAssertEqual(notes.id, file.path)
    XCTAssertEqual(notes.url, file)
    XCTAssertEqual(notes.size, Int64(content.count))
    XCTAssertEqual(try XCTUnwrap(notes.modified).timeIntervalSince1970, modified.timeIntervalSince1970, accuracy: 1)
    XCTAssertFalse(notes.isDirectory)
    XCTAssertFalse(notes.isSymbolicLink)
    XCTAssertFalse(notes.isPackage)
    XCTAssertFalse(notes.isHidden)
    XCTAssertEqual(notes.kind, "文本文档")
    XCTAssertEqual(entries[".hidden"]?.isHidden, true)
    XCTAssertEqual(entries["folder"]?.isDirectory, true)
    XCTAssertEqual(entries["folder"]?.kind, "文件夹")
    XCTAssertEqual(entries["folder"]?.size, 0)
    XCTAssertEqual(entries["Example.app"]?.isDirectory, true)
    XCTAssertEqual(entries["Example.app"]?.isPackage, true)
  }

  func testFileDirectoryPackageAndBrokenSymlinksRemainVisible() throws {
    let file = root.appendingPathComponent("target.txt")
    try Data("target contents".utf8).write(to: file)
    let folder = root.appendingPathComponent("target-folder")
    try manager.createDirectory(at: folder, withIntermediateDirectories: true)
    try Data("nested".utf8).write(to: folder.appendingPathComponent("nested.txt"))
    let package = root.appendingPathComponent("Target.app")
    try manager.createDirectory(at: package, withIntermediateDirectories: true)
    let targets = [
      "file-link": file,
      "directory-link": folder,
      "package-link": package,
      "broken-link": root.appendingPathComponent("does-not-exist"),
    ]
    for (name, target) in targets {
      try manager.createSymbolicLink(at: root.appendingPathComponent(name), withDestinationURL: target)
    }
    try manager.createSymbolicLink(atPath: root.appendingPathComponent("relative-link").path,
      withDestinationPath: "target-folder")

    let snapshot = try DirectoryReader.read(root)
    let entries = Dictionary(uniqueKeysWithValues: snapshot.entries.map { ($0.name, $0) })
    XCTAssertEqual(snapshot.skippedCount, 0)
    XCTAssertEqual(snapshot.entries.count, 8)
    for name in targets.keys { XCTAssertEqual(entries[name]?.isSymbolicLink, true) }
    XCTAssertEqual(entries["file-link"]?.isDirectory, false)
    XCTAssertEqual(entries["file-link"]?.kind, "符号链接")
    XCTAssertEqual(entries["directory-link"]?.isDirectory, true)
    XCTAssertEqual(entries["directory-link"]?.kind, "文件夹链接")
    XCTAssertEqual(entries["package-link"]?.isDirectory, true)
    XCTAssertEqual(entries["package-link"]?.isPackage, true)
    XCTAssertEqual(entries["broken-link"]?.isDirectory, false)
    XCTAssertEqual(entries["broken-link"]?.kind, "符号链接")
    XCTAssertEqual(entries["relative-link"]?.isDirectory, true)
    XCTAssertEqual(entries["relative-link"]?.isSymbolicLink, true)
    XCTAssertNil(entries["nested.txt"])
  }

  func testBrowsingDirectorySymlinkRetainsRequestedPaths() throws {
    let folder = root.appendingPathComponent("target")
    try manager.createDirectory(at: folder, withIntermediateDirectories: true)
    try Data("child".utf8).write(to: folder.appendingPathComponent("child.txt"))
    let link = root.appendingPathComponent("link")
    try manager.createSymbolicLink(at: link, withDestinationURL: folder)

    let snapshot = try DirectoryReader.read(link)
    XCTAssertEqual(snapshot.directory, link)
    XCTAssertEqual(snapshot.entries.map(\.name), ["child.txt"])
    XCTAssertEqual(snapshot.entries.first?.url.path, link.appendingPathComponent("child.txt").path)
    XCTAssertEqual(snapshot.skippedCount, 0)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(snapshot.entries.first).url), Data("child".utf8))
  }

  func testEmptyDirectory() throws {
    let snapshot = try DirectoryReader.read(root)
    XCTAssertTrue(snapshot.entries.isEmpty)
    XCTAssertEqual(snapshot.skippedCount, 0)
  }

  func testInvalidMissingAndFileInputsAreRejected() throws {
    let file = root.appendingPathComponent("plain.txt")
    try Data("unchanged".utf8).write(to: file)
    let broken = root.appendingPathComponent("broken")
    try manager.createSymbolicLink(at: broken, withDestinationURL: root.appendingPathComponent("missing"))
    let fileLink = root.appendingPathComponent("file-link")
    try manager.createSymbolicLink(at: fileLink, withDestinationURL: file)
    let invalidURLs = [
      URL(string: "https://example.invalid/folder")!,
      URL(string: "file://remote-host.invalid/folder")!,
      URL(string: "file:relative-folder")!,
      URL(string: "relative-folder")!,
      URL(string: "child", relativeTo: root)!,
      URL(string: "file:///tmp/example?query=value")!,
      URL(string: "file:///tmp/example#fragment")!,
      root.appendingPathComponent("missing"),
      file,
      broken,
      fileLink,
    ]
    for url in invalidURLs {
      XCTAssertThrowsError(try DirectoryReader.read(url), "Expected rejection of \(url)")
    }
    XCTAssertEqual(try Data(contentsOf: file), Data("unchanged".utf8))
  }

  func testCancellationPropagatesInsteadOfBecomingSkippedMetadata() async throws {
    let directory = try XCTUnwrap(root)
    try Data("preserved".utf8).write(to: directory.appendingPathComponent("file.txt"))
    let task = Task.detached { () throws -> DirectorySnapshot in
      withUnsafeCurrentTask { $0?.cancel() }
      return try DirectoryReader.read(directory)
    }
    do {
      _ = try await task.value
      XCTFail("A cancelled read must throw")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("file.txt")), Data("preserved".utf8))
  }

  func testReadingAndQueryingPreserveFixtureContentsAndMetadata() throws {
    let folder = root.appendingPathComponent("folder")
    try manager.createDirectory(at: folder, withIntermediateDirectories: true)
    let files = [root.appendingPathComponent("visible.txt"), root.appendingPathComponent(".hidden"),
      folder.appendingPathComponent("nested.bin")]
    for (index, file) in files.enumerated() {
      try Data("content \(index)".utf8).write(to: file)
      try manager.setAttributes([.posixPermissions: 0o640,
        .modificationDate: Date(timeIntervalSince1970: 1_700_000_000 + Double(index))], ofItemAtPath: file.path)
    }
    let link = root.appendingPathComponent("link")
    try manager.createSymbolicLink(atPath: link.path, withDestinationPath: "folder/nested.bin")
    let beforePaths = try manager.subpathsOfDirectory(atPath: root.path).sorted()
    let beforeContents = try files.map { try Data(contentsOf: $0) }
    let beforeAttributes = try files.map { try manager.attributesOfItem(atPath: $0.path) }
    let beforeLink = try manager.destinationOfSymbolicLink(atPath: link.path)

    for _ in 0..<3 {
      let snapshot = try DirectoryReader.read(root)
      for sort in EntrySort.allCases {
        _ = EntryQuery.apply(snapshot.entries, showHidden: false, query: "file", sort: sort, ascending: false)
      }
    }

    XCTAssertEqual(try manager.subpathsOfDirectory(atPath: root.path).sorted(), beforePaths)
    XCTAssertEqual(try files.map { try Data(contentsOf: $0) }, beforeContents)
    XCTAssertEqual(try manager.destinationOfSymbolicLink(atPath: link.path), beforeLink)
    for (index, file) in files.enumerated() {
      let after = try manager.attributesOfItem(atPath: file.path)
      XCTAssertEqual(after[.size] as? NSNumber, beforeAttributes[index][.size] as? NSNumber)
      XCTAssertEqual(after[.modificationDate] as? Date, beforeAttributes[index][.modificationDate] as? Date)
      XCTAssertEqual(after[.posixPermissions] as? NSNumber, beforeAttributes[index][.posixPermissions] as? NSNumber)
    }
  }
}
