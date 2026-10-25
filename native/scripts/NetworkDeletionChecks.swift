import Foundation
import Darwin

@main enum NetworkDeletionChecks {
  static func main() throws {
    let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent("network-delete-check-" + UUID().uuidString).resolvingSymlinksInPath()
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.appendingPathComponent("denied").path); try? fm.removeItem(at: root) }
    var count = 0
    func check(_ ok: @autoclosure () throws -> Bool, _ title: String) throws { guard try ok() else { fatalError(title) }; count += 1 }
    func rejects(_ title: String, _ body: () throws -> Void) throws { do { try body() } catch { count += 1; return }; fatalError(title) }
    func file(_ path: String) throws -> URL { let url = root.appendingPathComponent(path); try Data("keep".utf8).write(to: url); return url }
    func plan(_ url: URL, classifier: @escaping @Sendable (URL) -> DeletionVolume? = { _ in .network }) throws -> NetworkDeletion {
      try PreparedDeletion.fixtures([url], root: root, classification: classifier)[0].network!
    }
    let one = try file("one.txt")
    try rejects("production classifier rejects local permanent deletion") { _ = try NetworkDeletion(one) }
    try check(fm.fileExists(atPath: one.path), "rejected local item survives")
    let firstPlan = try plan(one)
    try check(try Data(contentsOf: one) == Data("keep".utf8), "preparation reads metadata only")
    try firstPlan.remove(); try check(!fm.fileExists(atPath: one.path), "confirmed regular fixture removed")
    try rejects("snapshot cannot be reused") { try firstPlan.remove() }
    try rejects("root protected") { _ = try plan(URL(fileURLWithPath: "/")) }
    try rejects("home protected") { _ = try plan(fm.homeDirectoryForCurrentUser) }
    try rejects("non-file URL rejected") { _ = try plan(URL(string: "smb://fixture/share")!) }
    let replaced = try file("replaced"), old = root.appendingPathComponent("old")
    let stale = try plan(replaced)
    try fm.moveItem(at: replaced, to: old); try Data("new".utf8).write(to: replaced)
    try rejects("replacement root rejected") { try stale.remove() }
    try check(try String(contentsOf: replaced) == "new", "replacement preserved")
    let tree = root.appendingPathComponent("tree/子目录"), outside = try file("outside.txt")
    try fm.createDirectory(at: tree, withIntermediateDirectories: true)
    _ = try file("tree/子目录/中文 空格.txt"); _ = try file("tree/子目录/._metadata")
    try fm.createSymbolicLink(at: tree.appendingPathComponent("escape"), withDestinationURL: root)
    try fm.createSymbolicLink(atPath: tree.appendingPathComponent("dangling").path, withDestinationPath: "/not-existing-delete-fixture")
    try plan(tree.deletingLastPathComponent()).remove()
    try check(!fm.fileExists(atPath: tree.deletingLastPathComponent().path), "nested tree and AppleDouble fixtures removed")
    try check(fm.fileExists(atPath: outside.path), "directory symlink not traversed")
    let link = root.appendingPathComponent("link"); try fm.createSymbolicLink(at: link, withDestinationURL: outside)
    try plan(link).remove()
    try check(fm.fileExists(atPath: outside.path), "top-level symlink deletes only link")
    let parent = root.appendingPathComponent("parent"); try fm.createDirectory(at: parent, withIntermediateDirectories: true)
    let child = try file("parent/child"), anchored = try plan(child)
    try fm.moveItem(at: parent, to: root.appendingPathComponent("parent-old")); try fm.createDirectory(at: parent, withIntermediateDirectories: true); _ = try file("parent/child")
    try rejects("parent replacement rejected") { try anchored.remove() }
    try check(fm.fileExists(atPath: child.path) && fm.fileExists(atPath: root.appendingPathComponent("parent-old/child").path), "both parent occupants preserved")
    let denied = root.appendingPathComponent("denied"); try fm.createDirectory(at: denied, withIntermediateDirectories: true); _ = try file("denied/keep")
    let blocked = try plan(denied); try fm.setAttributes([.posixPermissions: 0], ofItemAtPath: denied.path)
    if getuid() != 0 {
      do { try blocked.remove(); fatalError("denied directory removed") }
      catch { let e = error as NSError; try check((e.userInfo[NSUnderlyingErrorKey] as? NSError)?.domain == NSPOSIXErrorDomain && e.code == Int(EACCES) && (e.userInfo[NSFilePathErrorKey] as? String).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path } == denied.resolvingSymlinksInPath().path, "denied path and code preserved without chmod; domain=\(e.domain), code=\(e.code), path=\(e.userInfo[NSFilePathErrorKey] ?? "none"), expected=\(denied.path), underlying=\(e.userInfo[NSUnderlyingErrorKey] ?? "none")") }
      try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: denied.path)
      try check(fm.fileExists(atPath: denied.appendingPathComponent("keep").path), "failed deletion retains inaccessible contents")
    }
    let aliasTarget = root.appendingPathComponent("alias-target"), aliasOther = root.appendingPathComponent("alias-other"), alias = root.appendingPathComponent("alias")
    try fm.createDirectory(at: aliasTarget, withIntermediateDirectories: true); try fm.createDirectory(at: aliasOther, withIntermediateDirectories: true)
    _ = try file("alias-target/keep"); _ = try file("alias-other/keep")
    try fm.createSymbolicLink(at: alias, withDestinationURL: aliasTarget)
    let aliased = try plan(alias.appendingPathComponent("keep"))
    try fm.removeItem(at: alias); try fm.createSymbolicLink(at: alias, withDestinationURL: aliasOther)
    try rejects("parent symlink retargeted after confirmation") { try aliased.remove() }
    try check(fm.fileExists(atPath: aliasTarget.appendingPathComponent("keep").path) && fm.fileExists(atPath: aliasOther.appendingPathComponent("keep").path), "both alias locations preserved")
    let hard = try file("hard"), secondLink = root.appendingPathComponent("hard-other")
    try fm.linkItem(at: hard, to: secondLink); try plan(hard).remove()
    try check(try String(contentsOf: secondLink) == "keep", "deletion unlinks only the selected hard link")
    let marker = try file("network-classifier-marker"), changed = try file("changed-mount")
    let remounted = try plan(changed, classifier: { _ in FileManager.default.fileExists(atPath: marker.path) ? .network : .local })
    try fm.removeItem(at: marker)
    try rejects("changed mount classification rejected") { try remounted.remove() }
    try check(fm.fileExists(atPath: changed.path), "item survives a simulated change to local classification")
    print("NetworkDeletionChecks: \(count) assertions passed.")
  }
}
