import Foundation
import XCTest
@testable import ExplorerCore

final class EntryQueryTests: XCTestCase {
  private var root: URL!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("EntryQueryTests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    if let root { try FileManager.default.removeItem(at: root) }
    root = nil
  }

  func testNaturalNameOrderingAndFoldersFirstInBothDirections() {
    let entries = [entry("file10.txt"), entry("folder10", folder: true), entry("file2.txt"),
      entry("folder2", folder: true), entry("file1.txt")]
    XCTAssertEqual(names(entries, ascending: true), ["folder2", "folder10", "file1.txt", "file2.txt", "file10.txt"])
    XCTAssertEqual(names(entries, ascending: false), ["folder10", "folder2", "file10.txt", "file2.txt", "file1.txt"])
  }

  func testFoldersStayFirstForEverySortAndDirection() {
    let entries = [entry("a.txt", size: 1, modified: 1), entry("z", folder: true, size: 100, modified: 100),
      entry("z.txt", size: 100, modified: 100), entry("a", folder: true, size: 1, modified: 1)]
    for sort in EntrySort.allCases {
      for ascending in [true, false] {
        let result = EntryQuery.apply(entries, showHidden: true, query: "", sort: sort, ascending: ascending)
        XCTAssertEqual(result.map(\.isDirectory), [true, true, false, false], "\(sort), \(ascending)")
      }
    }
  }

  func testSizeSortAndNaturalNameTies() {
    let entries = [entry("item10", size: 10), entry("large", size: 100), entry("item2", size: 10), entry("small", size: 1)]
    XCTAssertEqual(names(entries, sort: .size), ["small", "item2", "item10", "large"])
    XCTAssertEqual(names(entries, sort: .size, ascending: false), ["large", "item10", "item2", "small"])
  }

  func testModifiedSortAndMissingDates() {
    let entries = [entry("new", modified: 200), entry("unknown"), entry("old10", modified: 100),
      entry("old2", modified: 100)]
    XCTAssertEqual(names(entries, sort: .modified), ["unknown", "old2", "old10", "new"])
    XCTAssertEqual(names(entries, sort: .modified, ascending: false), ["new", "old10", "old2", "unknown"])
  }

  func testCreatedSortKeepsMissingEpochAndEarlyDatesDistinct() {
    let entries = [entry("new", modified: -100, created: 200), entry("unknown", modified: 999),
      entry("old10", created: 100), entry("old2", created: 100), entry("epoch", created: 0), entry("early", created: -1)]
    XCTAssertEqual(names(entries, sort: .created), ["unknown", "early", "epoch", "old2", "old10", "new"])
    XCTAssertEqual(names(entries, sort: .created, ascending: false), ["new", "old10", "old2", "epoch", "early", "unknown"])
    let folders = [entry("file", created: -1), entry("folder", folder: true, created: 100)]
    for ascending in [true, false] {
      XCTAssertEqual(names(folders, sort: .created, ascending: ascending), ["folder", "file"])
    }
    let a = entry("same", created: 1, path: "a/same"), b = entry("same", created: 1, path: "b/same")
    XCTAssertEqual(EntryQuery.apply([b, a], showHidden: true, query: "", sort: .created, ascending: true), [a, b])
    XCTAssertEqual(EntryQuery.apply([a, b], showHidden: true, query: "", sort: .created, ascending: false), [b, a])
  }

  func testKindSortAndNameTies() {
    let entries = [entry("z.txt"), entry("z.jpg"), entry("a.txt"), entry("a.jpg")]
    XCTAssertEqual(names(entries, sort: .kind), ["a.txt", "z.txt", "a.jpg", "z.jpg"])
    XCTAssertEqual(names(entries, sort: .kind, ascending: false), ["z.jpg", "a.jpg", "z.txt", "a.txt"])
  }

  func testLiteralPathTieBreakerIsIndependentOfInputOrder() {
    let entries = [entry("Résumé.txt", path: "c/Résumé.txt"), entry("resume.txt", path: "a/resume.txt"),
      entry("RESUME.txt", path: "b/RESUME.txt")]
    for sort in EntrySort.allCases {
      let first = EntryQuery.apply(entries, showHidden: true, query: "", sort: sort, ascending: true)
      let second = EntryQuery.apply(Array(entries.reversed()), showHidden: true, query: "", sort: sort, ascending: true)
      XCTAssertEqual(first.map(\.id), second.map(\.id))
      XCTAssertEqual(first.map(\.name), ["resume.txt", "RESUME.txt", "Résumé.txt"])
      let descending = EntryQuery.apply(entries, showHidden: true, query: "", sort: sort, ascending: false)
      XCTAssertEqual(descending.map(\.id), first.reversed().map(\.id))
    }
  }

  func testDuplicateNamesUsePathTieBreaker() {
    let first = entry("same", path: "a/same")
    let second = entry("same", path: "b/same")
    XCTAssertEqual(EntryQuery.apply([second, first], showHidden: true, query: "", sort: .name, ascending: true),
      [first, second])
    XCTAssertEqual(EntryQuery.apply([first, second], showHidden: true, query: "", sort: .name, ascending: false),
      [second, first])
  }

  func testCaseAndDiacriticInsensitiveNameFilteringAndHiddenToggle() {
    let entries = [entry("Résumé.txt"), entry("RESUME draft.txt", hidden: true), entry("other.txt"),
      entry("other", path: "resume-parent/other")]
    XCTAssertEqual(EntryQuery.apply(entries, showHidden: false, query: "resume", sort: .name, ascending: true).map(\.name),
      ["Résumé.txt"])
    XCTAssertEqual(Set(EntryQuery.apply(entries, showHidden: true, query: "RÉSUMÉ", sort: .name, ascending: true).map(\.name)),
      ["Résumé.txt", "RESUME draft.txt"])
    XCTAssertEqual(EntryQuery.apply(entries, showHidden: false, query: "", sort: .name, ascending: true).count, 3)
    XCTAssertEqual(EntryQuery.apply(entries, showHidden: true, query: "", sort: .name, ascending: true).count, 4)
    XCTAssertTrue(EntryQuery.apply(entries, showHidden: true, query: "missing", sort: .name, ascending: true).isEmpty)
  }

  func testKindsIdentityAndHashability() {
    XCTAssertEqual(entry("plain").kind, "文件")
    XCTAssertEqual(entry("photo.JpG").kind, "JPEG 图像")
    XCTAssertEqual(entry("folder", folder: true).kind, "文件夹")
    let value = entry("example.txt")
    XCTAssertEqual(value.id, root.appendingPathComponent("example.txt").path)
    XCTAssertEqual(Set([value, value]).count, 1)
  }

  func testEmptyInputAndInputValuePreservation() {
    XCTAssertTrue(EntryQuery.apply([], showHidden: false, query: "", sort: .name, ascending: true).isEmpty)
    let entries = [entry("b.txt"), entry("a.txt", hidden: true)]
    let original = entries
    _ = EntryQuery.apply(entries, showHidden: false, query: "b", sort: .size, ascending: false)
    XCTAssertEqual(entries, original)
  }

  private func names(_ entries: [FileEntry], sort: EntrySort = .name, ascending: Bool = true) -> [String] {
    EntryQuery.apply(entries, showHidden: true, query: "", sort: sort, ascending: ascending).map(\.name)
  }

  private func entry(
    _ name: String,
    folder: Bool = false,
    size: Int64 = 0,
    modified: TimeInterval? = nil,
    created: TimeInterval? = nil,
    hidden: Bool = false,
    path: String? = nil
  ) -> FileEntry {
    FileEntry(
      url: root.appendingPathComponent(path ?? name),
      name: name,
      isDirectory: folder,
      isSymbolicLink: false,
      isPackage: false,
      size: size,
      modified: modified.map { Date(timeIntervalSince1970: $0) },
      isHidden: hidden,
      created: created.map { Date(timeIntervalSince1970: $0) }
    )
  }
}
