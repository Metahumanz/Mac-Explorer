import Foundation
import Darwin

private struct TrashCheckFailure: LocalizedError { let message: String; var errorDescription: String? { message } }
private final class TrashAssertions {
  var count = 0
  func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    count += 1
    guard try condition() else { throw TrashCheckFailure(message: "Assertion \(count): \(message)") }
  }
  func rejects(_ message: String, _ body: () throws -> Void) throws {
    count += 1
    do { try body() } catch { return }
    throw TrashCheckFailure(message: "Assertion \(count): expected rejection: \(message)")
  }
}
@main
private enum TrashChecks {
  static let fm = FileManager.default
  static func main() {
    let checks = TrashAssertions()
    do { try run(checks); print("TrashChecks: \(checks.count) assertions passed.") }
    catch { fputs("TrashChecks FAILED: \(error.localizedDescription)\n", stderr); exit(1) }
  }
  @discardableResult static func directory(_ url: URL) throws -> URL { try fm.createDirectory(at: url, withIntermediateDirectories: true); return url }
  @discardableResult static func file(_ url: URL, _ text: String) throws -> URL { try Data(text.utf8).write(to: url); return url }
  static func text(_ url: URL) throws -> String { try String(contentsOf: url, encoding: .utf8) }
  static func exists(_ url: URL) -> Bool { var value = stat(); return url.path.withCString { lstat($0, &value) } == 0 }
  static func run(_ c: TrashAssertions) throws {
    // All roots are simulated directories beneath this fresh fixture. No system Trash API is invoked.
    let fixture = try directory(fm.temporaryDirectory.appendingPathComponent("ExplorerTrashChecks-" + UUID().uuidString)).resolvingSymlinksInPath()
    defer { try? fm.removeItem(at: fixture) }
    let home = try directory(fixture.appendingPathComponent("home/.Trash")), external = try directory(fixture.appendingPathComponent("volume/.Trashes/501"))
    let records = fixture.appendingPathComponent("records"), missing = fixture.appendingPathComponent("missing")
    let invalid = try file(fixture.appendingPathComponent("not-directory"), "fixture")
    let store = TrashStore(roots: [home, external, missing], records: records)
    let folder = try directory(home.appendingPathComponent("folder")); try file(folder.appendingPathComponent("child.txt"), "child")
    let first = try file(home.appendingPathComponent("same.txt"), "home"), second = try file(external.appendingPathComponent("same.txt"), "external")
    let merged = try store.list()
    try c.expect(merged.entries.filter { $0.name == "same.txt" }.count == 2, "merge roots retains duplicate names")
    try c.expect(merged.skippedCount == 0, "absent volume ignored")
    try c.expect(try store.list(folder).entries.count == 1, "browse nested trash folder")
    try c.expect(try text(first) == "home" && text(second) == "external", "browsing does not alter data")
    try c.rejects("outside navigation") { _ = try store.list(fixture) }
    try c.rejects("root is not an item") { _ = try store.validate(home) }
    let outside = try directory(fixture.appendingPathComponent("outside")), keep = try file(outside.appendingPathComponent("keep"), "safe")
    let escape = home.appendingPathComponent("escape"); try fm.createSymbolicLink(at: escape, withDestinationURL: outside)
    try c.rejects("external symlink directory navigation") { _ = try store.list(escape) }
    try c.rejects("symlink parent cannot escape") { _ = try store.validate(escape.appendingPathComponent("keep")) }
    try c.expect(try store.validate(escape).lastPathComponent == escape.lastPathComponent, "symlink object is a valid item")
    let symlinkRoot = fixture.appendingPathComponent("trash-root-alias"); try fm.createSymbolicLink(at: symlinkRoot, withDestinationURL: home)
    let linkedStore = TrashStore(roots: [symlinkRoot], records: records)
    try c.expect(try linkedStore.list().skippedCount == 1, "symlink root unavailable")
    try c.rejects("symlink root snapshot") { _ = try linkedStore.snapshot() }
    try c.rejects("symlink root item") { _ = try linkedStore.validate(symlinkRoot.appendingPathComponent("same.txt")) }
    let invalidStore = TrashStore(roots: [home, invalid, missing], records: records)
    try c.expect(try invalidStore.list().skippedCount == 1, "nondirectory root reported")
    try c.rejects("cannot partially snapshot unreadable roots") { _ = try invalidStore.snapshot() }
    let denied = try directory(fixture.appendingPathComponent("denied")); try fm.setAttributes([.posixPermissions: 0o000], ofItemAtPath: denied.path)
    defer { try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: denied.path) }
    if getuid() != 0 {
      let deniedStore = TrashStore(roots: [home, denied], records: records)
      try c.expect(try deniedStore.list().skippedCount == 1, "permission error reported, not missing")
      try c.rejects("permission error prevents empty confirmation") { _ = try deniedStore.snapshot() }
    }
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: denied.path)
    try c.expect(try TrashStore(roots: [home, home], records: records).list().entries.count == store.list(home).entries.count, "duplicate configured roots do not duplicate entries")
    try c.rejects("nonlocal file URL") { _ = try store.validate(URL(string: "file://example.invalid" + first.path)!) }
    try c.rejects("path prefix lookalike") { _ = try store.validate(URL(fileURLWithPath: home.path + "-other/file")) }
    // Origins persist across restarts but never attach to replacement entries.
    let originalDirectory = try directory(fixture.appendingPathComponent("original")), explicit = try directory(fixture.appendingPathComponent("restored"))
    let trashed = try file(home.appendingPathComponent("document (2).txt"), "original contents"), original = originalDirectory.appendingPathComponent("document.txt")
    try store.remember(trashed, original: original)
    try c.expect(store.original(trashed)?.lastPathComponent == original.lastPathComponent, "origin name is independent of collision trash name")
    try file(original, "existing contents")
    let blocked = store.restore([trashed])
    try c.expect(blocked.errors.count == 1 && blocked.succeeded.isEmpty, "restore collision refused")
    try c.expect(try text(original) == "existing contents" && text(trashed) == "original contents", "collision preserves both files")
    try fm.removeItem(at: original)
    let restarted = TrashStore(roots: [home, external], records: records)
    try c.expect(restarted.restore([trashed]).errors.isEmpty, "persisted origin restores after restart")
    try c.expect(try text(original) == "original contents", "origin restored exactly")
    try file(trashed, "unknown origin")
    try c.expect(store.original(trashed) == nil, "successful restore removes origin record")
    try c.expect(store.restore([trashed]).errors.count == 1, "unknown origin requires chooser")
    try c.expect(store.restore([trashed], to: explicit).errors.isEmpty, "explicit chooser restores unknown origin")
    try c.expect(try text(explicit.appendingPathComponent(trashed.lastPathComponent)) == "unknown origin", "unknown origin retains trash name")
    let known = try file(external.appendingPathComponent("known-collision-name"), "known"), knownOriginal = originalDirectory.appendingPathComponent("known.txt")
    try store.remember(known, original: knownOriginal)
    try c.expect(store.restore([known], to: explicit).errors.isEmpty, "explicit destination accepts known origin")
    try c.expect(try text(explicit.appendingPathComponent("known.txt")) == "known", "known origin preserves real name in explicit folder")
    let stale = try file(home.appendingPathComponent("stale"), "old"), staleOriginal = originalDirectory.appendingPathComponent("old")
    try store.remember(stale, original: staleOriginal); try fm.moveItem(at: stale, to: fixture.appendingPathComponent("saved-old")); try file(stale, "replacement")
    try c.expect(store.original(stale) == nil, "stale identity rejected")
    try c.expect(store.restore([stale]).errors.count == 1, "stale record cannot restore replacement")
    try c.expect(try text(stale) == "replacement", "stale replacement retained")
    try c.expect(store.restore([stale], to: home).errors.count == 1, "restore into same trash rejected")
    let backAlias = fixture.appendingPathComponent("trash-destination-alias"); try fm.createSymbolicLink(at: backAlias, withDestinationURL: external)
    try c.expect(store.restore([stale], to: backAlias).errors.count == 1, "restore through alias into another trash rejected")
    try c.expect(store.restore([keep], to: explicit).errors.count == 1, "outside source rejected")
    try c.expect(store.restore([escape.appendingPathComponent("keep")], to: explicit).errors.count == 1, "restore source symlink parent escape rejected")
    let movedParentItem = try file(home.appendingPathComponent("parent-guard"), "guarded"), parentOriginal = originalDirectory.appendingPathComponent("parent-guard")
    try store.remember(movedParentItem, original: parentOriginal)
    let savedParent = fixture.appendingPathComponent("saved-original-parent"); try fm.moveItem(at: originalDirectory, to: savedParent)
    try fm.createSymbolicLink(at: originalDirectory, withDestinationURL: outside)
    try c.expect(store.restore([movedParentItem]).errors.count == 1, "origin parent replacement rejected")
    try c.expect(!exists(outside.appendingPathComponent("parent-guard")) && exists(movedParentItem), "parent escape does not move data")
    try c.expect(store.restore([movedParentItem], to: explicit).errors.isEmpty, "chooser recovers after original parent changed")
    let trashFolder = try directory(home.appendingPathComponent("restore-tree")), treeChild = try file(trashFolder.appendingPathComponent("nested"), "nested")
    try c.expect(store.restore([treeChild, trashFolder, trashFolder], to: explicit).succeeded.count == 1, "parent selection subsumes duplicate descendants")
    try c.expect(try text(explicit.appendingPathComponent("restore-tree/nested")) == "nested", "selected tree restored once")
    // Confirmation snapshots bind the root and each top-level inode, not just the pathname.
    let replaced = try file(home.appendingPathComponent("replaced"), "old")
    let confirmation = try store.snapshot()
    try fm.moveItem(at: replaced, to: fixture.appendingPathComponent("saved-replaced")); try file(replaced, "new")
    let arrived = try file(home.appendingPathComponent("arrived"), "new arrival")
    let outcome = store.empty(confirmation)
    try c.expect(outcome.errors.count == 1, "replacement skipped while other confirmed items removed")
    try c.expect(try text(replaced) == "new" && text(arrived) == "new arrival", "replacement and unconfirmed arrival survive")
    try c.expect(try text(keep) == "safe", "empty unlinks escape symlink without following target")
    try c.expect(!exists(escape) && !exists(folder) && !exists(second), "confirmed links and trees removed across roots")
    let beforeRootSwap = try store.snapshot(), savedRoot = fixture.appendingPathComponent("saved-trash-root")
    try fm.moveItem(at: home, to: savedRoot); try directory(home)
    for item in beforeRootSwap where URL(fileURLWithPath: item.path).deletingLastPathComponent().lastPathComponent == home.lastPathComponent {
      let name = URL(fileURLWithPath: item.path).lastPathComponent
      try fm.moveItem(at: savedRoot.appendingPathComponent(name), to: home.appendingPathComponent(name))
    }
    let swappedResult = store.empty(beforeRootSwap)
    try c.expect(swappedResult.succeeded.isEmpty && swappedResult.errors.count == beforeRootSwap.count, "same file identities under replacement root still refused")
    try c.expect(try text(arrived) == "new arrival", "root replacement preserves entries")
    let forgedChild = try file((try directory(home.appendingPathComponent("nested-parent"))).appendingPathComponent("nested-child"), "not top level")
    let forged = TrashItemSnapshot(path: forgedChild.path, identity: try TrashStore.identity(forgedChild), parentIdentity: try TrashStore.identity(forgedChild.deletingLastPathComponent()))
    try c.expect(store.empty([forged]).errors.count == 1 && exists(forgedChild), "forged nested snapshot rejected")
    let forgedOutside = TrashItemSnapshot(path: keep.path, identity: try TrashStore.identity(keep), parentIdentity: try TrashStore.identity(outside))
    try c.expect(store.empty([forgedOutside]).errors.count == 1 && (try text(keep)) == "safe", "forged outside snapshot rejected")
    let linksOnly = try directory(fixture.appendingPathComponent("links-only")), dangling = linksOnly.appendingPathComponent("dangling")
    try fm.createSymbolicLink(atPath: dangling.path, withDestinationPath: "/this-fixture-target-does-not-exist")
    let linkStore = TrashStore(roots: [linksOnly], records: records)
    try c.expect(linkStore.empty(try linkStore.snapshot()).errors.isEmpty && !exists(dangling), "dangling symlink empty removes link object")
    let originRoot = try directory(fixture.appendingPathComponent("origin-root"))
    let originRecords = fixture.appendingPathComponent("origin-records")
    let originStore = TrashStore(roots: [originRoot], records: originRecords)
    let bound = try file(originRoot.appendingPathComponent("bound"), "original bound data")
    try originStore.remember(bound, original: explicit.appendingPathComponent("bound-original"))
    let oldOriginRoot = fixture.appendingPathComponent("old-origin-root")
    try fm.moveItem(at: originRoot, to: oldOriginRoot); try directory(originRoot)
    try fm.moveItem(at: oldOriginRoot.appendingPathComponent("bound"), to: bound)
    try c.expect(originStore.original(bound) == nil, "origin binds trash root identity even when same entry is moved back")
    try c.expect(originStore.restore([bound]).errors.count == 1 && (try text(bound)) == "original bound data", "replacement root cannot reuse old provenance")
    let recordItem = try file(originRoot.appendingPathComponent("record-link"), "record source")
    try originStore.remember(recordItem, original: explicit.appendingPathComponent("record-original"))
    let metadataFiles = try fm.contentsOfDirectory(at: originRecords, includingPropertiesForKeys: nil)
    guard let metadata = metadataFiles.first(where: { (try? String(contentsOf: $0, encoding: .utf8).contains("record-original")) == true }) else { throw TrashCheckFailure(message: "Missing record fixture") }
    try fm.moveItem(at: metadata, to: fixture.appendingPathComponent("saved-origin-record"))
    try fm.createSymbolicLink(at: metadata, withDestinationURL: keep)
    try c.expect(originStore.original(recordItem) == nil, "symlink provenance record rejected")
    try c.rejects("remember cannot overwrite provenance symlink") { try originStore.remember(recordItem, original: explicit.appendingPathComponent("record-original")) }
    try c.expect(try text(keep) == "safe", "record symlink target stays intact")
    let recordsAlias = fixture.appendingPathComponent("records-alias"); try fm.createSymbolicLink(at: recordsAlias, withDestinationURL: originRecords)
    let aliasRecordsStore = TrashStore(roots: [originRoot], records: recordsAlias)
    try c.expect(aliasRecordsStore.original(recordItem) == nil, "symlink record directory rejected")
    try c.rejects("remember cannot use symlink record directory") { try aliasRecordsStore.remember(recordItem, original: explicit.appendingPathComponent("record-original")) }
    try c.expect(store.restore([], to: explicit).errors.isEmpty && store.empty([]).succeeded.isEmpty, "empty selection is a no-op")
  }
}
