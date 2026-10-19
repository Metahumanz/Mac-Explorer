import Foundation
import Darwin

private struct CheckFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

private final class Checks {
  var count = 0

  func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    count += 1
    guard try condition() else { throw CheckFailure(message: "Assertion \(count): \(message)") }
  }

  func rejects(_ message: String, _ action: () throws -> Void) throws {
    count += 1
    do {
      try action()
    } catch {
      return
    }
    throw CheckFailure(message: "Assertion \(count): expected rejection: \(message)")
  }
}

@main
private enum FileActionChecks {
  static let manager = FileManager.default

  static func main() {
    NativeLanguage.mode = "zh-CN"
    let checks = Checks()
    do {
      try run(checks)
      print("FileActionChecks: \(checks.count) assertions passed.")
    } catch {
      fputs("FileActionChecks FAILED after \(checks.count) assertions: \(error.localizedDescription)\n", stderr)
      exit(1)
    }
  }

  static func directory(_ url: URL) throws -> URL {
    try manager.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  static func file(_ url: URL, _ contents: String) throws -> URL {
    try Data(contents.utf8).write(to: url)
    return url
  }

  static func text(_ url: URL) throws -> String {
    try String(contentsOf: url, encoding: .utf8)
  }

  static func exists(_ url: URL) -> Bool {
    var info = stat()
    return url.path.withCString { Darwin.lstat($0, &info) } == 0
  }

  static func link(_ url: URL, target: String) throws -> URL {
    try manager.createSymbolicLink(atPath: url.path, withDestinationPath: target)
    return url
  }

  static func run(_ c: Checks) throws {
    // Every writable path, including simulated trash, belongs to a fresh temporary fixture.
    let root = try directory(manager.temporaryDirectory.appendingPathComponent("ExplorerFileActionChecks-\(UUID().uuidString)"))
    defer { try? manager.removeItem(at: root) }
    let trash = try directory(root.appendingPathComponent("trash"))
    let source = try directory(root.appendingPathComponent("source"))
    let destination = try directory(root.appendingPathComponent("destination"))

    let literalName = "literal-{1}-%@.txt"
    let literalPath = source.appendingPathComponent(literalName)
    do {
      _ = try FileActions.rename(literalPath, to: "unused")
      throw CheckFailure(message: "missing source accepted")
    } catch {
      try c.expect(error.localizedDescription.contains(literalPath.path), "missing-source error contains the actual path without formatting user tokens")
    }
    let collisionSource = try file(source.appendingPathComponent("localized-collision-source"), "source")
    _ = try file(literalPath, "collision")
    do {
      _ = try FileActions.rename(collisionSource, to: literalName)
      throw CheckFailure(message: "collision accepted")
    } catch {
      try c.expect(error.localizedDescription.contains(literalPath.path), "collision error contains the actual destination path")
    }
    try c.expect(NL("{0} / {1}", literalPath.path, "end") == literalPath.path + " / end", "inserted user path placeholders are not recursively substituted")

    let template = try file(root.appendingPathComponent("template.docx"), "fixture template payload")
    let fromTemplate = try FileActions.create(in: source, name: "document.docx", directory: false, template: template)
    try c.expect(try text(fromTemplate.destination) == "fixture template payload", "new document copies the complete template")
    try c.expect(fromTemplate.kind == .create && fromTemplate.source == nil, "template creation has a reversible create record")
    try c.rejects("template creation does not overwrite existing files") { _ = try FileActions.create(in: source, name: "document.docx", directory: false, template: template) }
    try c.expect(try text(template) == "fixture template payload", "template source is unchanged")
    try c.rejects("directory is not a document template") { _ = try FileActions.create(in: source, name: "invalid.docx", directory: false, template: destination) }
    let created = try FileActions.create(in: source, name: "new.txt", directory: false)
    try c.expect(created.kind == .create && created.source == nil, "new file change record")
    try c.expect(try text(created.destination) == "", "new file starts empty")
    let createdFolder = try FileActions.create(in: source, name: "New folder", directory: true)
    try c.expect(try manager.contentsOfDirectory(atPath: createdFolder.destination.path).isEmpty, "new folder starts empty")
    let unicode = try FileActions.create(in: source, name: "你好.txt", directory: false)
    try c.expect(exists(unicode.destination), "Unicode filenames")
    _ = try file(created.destination, "keep original")
    try c.rejects("create cannot truncate an existing file") {
      _ = try FileActions.create(in: source, name: "new.txt", directory: false)
    }
    try c.expect(try text(created.destination) == "keep original", "create collision preserves file")
    try c.rejects("create cannot accept an existing folder") {
      _ = try FileActions.create(in: source, name: "New folder", directory: true)
    }
    let createLink = try link(source.appendingPathComponent("create-link"), target: "missing-target")
    try c.rejects("create cannot follow a broken destination symlink") {
      _ = try FileActions.create(in: source, name: "create-link", directory: false)
    }
    try c.expect(try manager.destinationOfSymbolicLink(atPath: createLink.path) == "missing-target", "create preserves destination link")
    try c.rejects("file is not a destination directory") {
      _ = try FileActions.create(in: created.destination, name: "child", directory: false)
    }

    let invalidNames = ["", " ", "\n\t", ".", "..", "bad/name", "bad:name", "bad\0name",
      String(repeating: "a", count: 256), String(repeating: "界", count: 86)]
    for name in invalidNames {
      try c.rejects("invalid create name \(name.debugDescription)") {
        _ = try FileActions.create(in: source, name: name, directory: false)
      }
      try c.rejects("invalid rename name \(name.debugDescription)") {
        _ = try FileActions.rename(created.destination, to: name)
      }
      try c.expect(try text(created.destination) == "keep original", "invalid rename preserves source")
    }
    let longName = String(repeating: "a", count: 255)
    let longFile = try FileActions.create(in: source, name: longName, directory: false)
    try c.expect(exists(longFile.destination), "255-byte name accepted")
    let longCopy = FileActions.transfer([longFile.destination], to: source, move: false)
    try c.expect(longCopy.errors.isEmpty && longCopy.changes.count == 1, "long same-folder copy succeeds")
    try c.expect(longCopy.succeeded[0].lastPathComponent.utf8.count <= 255, "copy suffix remains within byte limit")

    let invalidURLs = [URL(string: "https://example.invalid/file")!, URL(string: "file:relative")!,
      URL(fileURLWithPath: "/"), URL(fileURLWithPath: source.path + "/bad\0name"),
      URL(string: "file://example.invalid/tmp/file")!]
    for invalid in invalidURLs {
      try c.rejects("invalid create parent") {
        _ = try FileActions.create(in: invalid, name: "invalid", directory: false)
      }
      try c.expect(FileActions.transfer([invalid], to: destination, move: false).errors.count == 1, "invalid transfer source rejected")
      try c.expect(FileActions.trash([invalid], testTrash: trash).errors.count == 1, "invalid trash source rejected")
    }
    try c.expect(FileActions.transfer([created.destination], to: URL(fileURLWithPath: "/"), move: false).errors.count == 1, "root destination rejected")

    let renamed = try FileActions.rename(created.destination, to: "renamed.txt")
    try c.expect(renamed.kind == .move && renamed.source == created.destination, "rename change record")
    try c.expect(!exists(created.destination) && (try text(renamed.destination)) == "keep original", "rename moves contents")
    let renameBlocker = try file(source.appendingPathComponent("blocker.txt"), "blocker content")
    try c.rejects("rename collision") { _ = try FileActions.rename(renamed.destination, to: "blocker.txt") }
    try c.expect(try text(renameBlocker) == "blocker content", "rename collision preserves destination")
    try c.expect(try text(renamed.destination) == "keep original", "rename collision preserves source")
    try c.rejects("rename destination may not be a broken symlink") {
      _ = try FileActions.rename(renamed.destination, to: createLink.lastPathComponent)
    }
    try c.expect(try manager.destinationOfSymbolicLink(atPath: createLink.path) == "missing-target", "rename collision preserves broken symlink")
    let noopRename = try FileActions.rename(renamed.destination, to: "renamed.txt")
    let undoNoop = FileActions.undo([noopRename], testTrash: trash)
    try c.expect(undoNoop.errors.isEmpty && undoNoop.changes.isEmpty, "same-name rename undo is a no-op")
    try c.expect(try text(renamed.destination) == "keep original", "no-op rename preserves content")

    let mixedCase = try file(source.appendingPathComponent("CaseOnly.txt"), "case data")
    let caseRename = try FileActions.rename(mixedCase, to: "CASEONLY.txt")
    let caseNames = try manager.contentsOfDirectory(atPath: source.path)
    try c.expect(caseNames.contains("CASEONLY.txt") && !caseNames.contains("CaseOnly.txt"), "case-only rename changes directory spelling")
    try c.expect(try text(caseRename.destination) == "case data", "case-only rename preserves contents")
    let caseUndo = FileActions.undo([caseRename], testTrash: trash)
    try c.expect(caseUndo.errors.isEmpty && caseUndo.changes.count == 1, "case-only rename undo")
    try c.expect(try manager.contentsOfDirectory(atPath: source.path).contains("CaseOnly.txt"), "case-only undo restores spelling")
    try c.expect(try manager.contentsOfDirectory(atPath: source.path).allSatisfy { !$0.hasPrefix(".explorer-rename-") }, "case-only rename leaves no temporary files")
    let hardLink = source.appendingPathComponent("hard-link.txt")
    try manager.linkItem(at: renamed.destination, to: hardLink)
    try c.rejects("same-inode distinct hardlink is a collision") { _ = try FileActions.rename(renamed.destination, to: "hard-link.txt") }
    try c.expect(exists(renamed.destination) && exists(hardLink), "hardlink collision preserves both entries")

    let copied = FileActions.transfer([renamed.destination], to: destination, move: false)
    try c.expect(copied.errors.isEmpty && copied.changes.count == 1 && copied.changes[0].kind == .copy, "copy result")
    let copiedURL = destination.appendingPathComponent("renamed.txt")
    try c.expect(try text(copiedURL) == "keep original", "copied content")
    try c.expect(try text(renamed.destination) == "keep original", "copy preserves original")
    _ = try file(copiedURL, "destination is different")
    for move in [false, true] {
      let collision = FileActions.transfer([renamed.destination], to: destination, move: move)
      try c.expect(collision.errors.count == 1 && collision.changes.isEmpty, "standard transfer collision rejected")
      try c.expect(try text(copiedURL) == "destination is different", "collision preserves destination content")
      try c.expect(try text(renamed.destination) == "keep original", "collision preserves source content")
    }

    let tree = try directory(source.appendingPathComponent("tree.folder"))
    let nested = try directory(tree.appendingPathComponent("nested"))
    _ = try file(nested.appendingPathComponent("leaf.txt"), "tree content")
    _ = try link(tree.appendingPathComponent("relative-link"), target: "nested/leaf.txt")
    let treeCopy = FileActions.transfer([tree], to: destination, move: false)
    try c.expect(treeCopy.errors.isEmpty && treeCopy.changes.count == 1, "recursive directory copy")
    let copiedTree = destination.appendingPathComponent("tree.folder")
    try c.expect(try text(copiedTree.appendingPathComponent("nested/leaf.txt")) == "tree content", "recursive contents")
    try c.expect(try manager.destinationOfSymbolicLink(atPath: copiedTree.appendingPathComponent("relative-link").path) == "nested/leaf.txt", "recursive copy preserves relative link")
    let treeCollision = FileActions.transfer([tree], to: destination, move: false)
    try c.expect(treeCollision.errors.count == 1 && treeCollision.changes.isEmpty, "existing directory is not merged")
    try c.expect(try text(copiedTree.appendingPathComponent("nested/leaf.txt")) == "tree content", "directory collision preserves child")
    let treeUndo = FileActions.undo(treeCopy.changes, testTrash: trash)
    try c.expect(treeUndo.errors.isEmpty && !exists(copiedTree), "undo directory copy moves copy to trash")
    try c.expect(try text(treeUndo.succeeded[0].appendingPathComponent("nested/leaf.txt")) == "tree content", "undo directory copy preserves nested contents")
    try c.expect(try text(nested.appendingPathComponent("leaf.txt")) == "tree content", "undo directory copy preserves source tree")
    let directoryMove = FileActions.transfer([tree], to: destination, move: true)
    try c.expect(directoryMove.errors.isEmpty && !exists(tree), "move directory")
    try c.expect(try text(copiedTree.appendingPathComponent("nested/leaf.txt")) == "tree content", "moved directory contents")
    try c.expect(FileActions.undo(directoryMove.changes, testTrash: trash).errors.isEmpty, "undo directory move")
    try c.expect(exists(tree) && !exists(copiedTree), "undo directory move restores original location")
    let directoryTrash = FileActions.trash([tree], testTrash: trash)
    try c.expect(directoryTrash.errors.isEmpty && !exists(tree), "trash directory")
    try c.expect(try text(directoryTrash.succeeded[0].appendingPathComponent("nested/leaf.txt")) == "tree content", "trash directory retains nested contents")
    try c.expect(FileActions.undo(directoryTrash.changes, testTrash: trash).errors.isEmpty && exists(tree), "undo directory trash")
    let directoryRename = try FileActions.rename(tree, to: "TREE.FOLDER")
    try c.expect(try manager.contentsOfDirectory(atPath: source.path).contains("TREE.FOLDER"), "case-only directory rename")
    try c.expect(FileActions.undo([directoryRename], testTrash: trash).errors.isEmpty, "undo case-only directory rename")
    try c.expect(try text(nested.appendingPathComponent("leaf.txt")) == "tree content", "directory rename preserves descendants")

    let alias = try link(root.appendingPathComponent("nested-alias"), target: nested.path)
    for move in [false, true] {
      for inside in [tree, nested, alias] {
        let rejected = FileActions.transfer([tree], to: inside, move: move)
        try c.expect(rejected.errors.count == 1 && rejected.changes.isEmpty, "self/descendant transfer rejected, including aliases")
        try c.expect(try text(nested.appendingPathComponent("leaf.txt")) == "tree content", "descendant rejection preserves tree")
      }
    }
    try c.expect(!exists(nested.appendingPathComponent("tree.folder")), "no recursive destination created")

    let besideOne = FileActions.transfer([renamed.destination], to: source, move: false)
    let besideTwo = FileActions.transfer([renamed.destination], to: source, move: false)
    try c.expect(besideOne.errors.isEmpty && besideOne.succeeded[0].lastPathComponent == "renamed - 副本.txt", "same-folder copy suffix")
    try c.expect(besideTwo.errors.isEmpty && besideTwo.succeeded[0].lastPathComponent == "renamed - 副本 (2).txt", "numbered same-folder copy suffix")
    let suffixLink = try link(source.appendingPathComponent("renamed - 副本 (3).txt"), target: "does-not-exist")
    let besideFour = FileActions.transfer([renamed.destination], to: source, move: false)
    try c.expect(besideFour.errors.isEmpty && besideFour.succeeded[0].lastPathComponent == "renamed - 副本 (4).txt", "copy suffix skips dangling-link collision")
    try c.expect(try manager.destinationOfSymbolicLink(atPath: suffixLink.path) == "does-not-exist", "suffix collision preserves symlink")
    try c.expect(try text(besideOne.succeeded[0]) == "keep original", "later copies preserve earlier copy")
    let besideTree = FileActions.transfer([tree], to: source, move: false)
    try c.expect(besideTree.errors.isEmpty && besideTree.succeeded[0].lastPathComponent == "tree.folder - 副本", "folder suffix does not split extension")
    let dotfile = try file(source.appendingPathComponent(".hidden"), "hidden")
    let dotCopy = FileActions.transfer([dotfile], to: source, move: false)
    try c.expect(dotCopy.errors.isEmpty && dotCopy.succeeded[0].lastPathComponent == ".hidden - 副本", "dotfile copy naming")
    let sameMove = FileActions.transfer([renamed.destination, tree], to: source, move: true)
    try c.expect(sameMove.errors.isEmpty && sameMove.succeeded.count == 2 && sameMove.changes.isEmpty, "same-folder cut is a no-op")
    let sourceAlias = try link(root.appendingPathComponent("source-alias"), target: source.path)
    let aliasMove = FileActions.transfer([renamed.destination], to: sourceAlias, move: true)
    try c.expect(aliasMove.errors.isEmpty && aliasMove.changes.isEmpty, "same-folder cut through symlink alias is a no-op")
    let aliasCopy = FileActions.transfer([dotfile], to: sourceAlias, move: false)
    try c.expect(aliasCopy.errors.isEmpty && aliasCopy.succeeded[0].lastPathComponent == ".hidden - 副本 (2)", "same-folder copy through alias uses suffix")

    let liveLink = try link(source.appendingPathComponent("live-link"), target: "renamed.txt")
    let brokenLink = try link(source.appendingPathComponent("broken-link"), target: "absent-target")
    let directoryLink = try link(source.appendingPathComponent("directory-link"), target: "tree.folder")
    let links = FileActions.transfer([liveLink, brokenLink, directoryLink], to: destination, move: false)
    try c.expect(links.errors.isEmpty && links.changes.count == 3, "copy live, broken, and directory symlinks")
    for (url, target) in [(liveLink, "renamed.txt"), (brokenLink, "absent-target"), (directoryLink, "tree.folder")] {
      try c.expect(try manager.destinationOfSymbolicLink(atPath: destination.appendingPathComponent(url.lastPathComponent).path) == target, "copied link target is unchanged")
      try c.expect(try manager.destinationOfSymbolicLink(atPath: url.path) == target, "source link is unchanged")
    }
    let symlinkCollision = FileActions.transfer([brokenLink], to: destination, move: true)
    try c.expect(symlinkCollision.errors.count == 1 && exists(brokenLink), "broken destination link blocks transfer")
    let linkMoveDirectory = try directory(root.appendingPathComponent("link-moves"))
    let linkMove = FileActions.transfer([brokenLink], to: linkMoveDirectory, move: true)
    try c.expect(linkMove.errors.isEmpty && !exists(brokenLink), "move broken link object")
    try c.expect(try manager.destinationOfSymbolicLink(atPath: linkMove.succeeded[0].path) == "absent-target", "moved broken link retains target")
    let linkUndo = FileActions.undo(linkMove.changes, testTrash: trash)
    try c.expect(linkUndo.errors.isEmpty && exists(brokenLink), "undo broken link move")
    let renamedLink = try FileActions.rename(brokenLink, to: "renamed-broken-link")
    try c.expect(try manager.destinationOfSymbolicLink(atPath: renamedLink.destination.path) == "absent-target", "rename broken symlink object")
    try c.expect(FileActions.undo([renamedLink], testTrash: trash).errors.isEmpty && exists(brokenLink), "undo broken symlink rename")

    let moveSource = try file(source.appendingPathComponent("move-me.txt"), "move content")
    let moved = FileActions.transfer([moveSource], to: destination, move: true)
    try c.expect(moved.errors.isEmpty && moved.changes.count == 1 && moved.changes[0].kind == .move, "move result")
    try c.expect(!exists(moveSource) && (try text(moved.succeeded[0])) == "move content", "move relocates contents")
    let unmoved = FileActions.undo(moved.changes, testTrash: trash)
    try c.expect(unmoved.errors.isEmpty && (try text(moveSource)) == "move content", "undo move restores source")
    try c.expect(!exists(moved.succeeded[0]), "undo move vacates destination")
    let moveAgain = FileActions.transfer([moveSource], to: destination, move: true)
    _ = try file(moveSource, "new occupant")
    let blockedMoveUndo = FileActions.undo(moveAgain.changes, testTrash: trash)
    try c.expect(blockedMoveUndo.errors.count == 1 && blockedMoveUndo.changes.isEmpty, "undo move collision rejected")
    try c.expect(try text(moveSource) == "new occupant", "undo move preserves new occupant")
    try c.expect(try text(moveAgain.succeeded[0]) == "move content", "undo move preserves moved item")
    let linkBlockedSource = try file(source.appendingPathComponent("undo-link-collision.txt"), "original item")
    let linkBlockedMove = FileActions.transfer([linkBlockedSource], to: destination, move: true)
    try c.expect(linkBlockedMove.errors.isEmpty, "prepare broken-link undo collision")
    _ = try link(linkBlockedSource, target: "missing-occupant")
    let blockedByLink = FileActions.undo(linkBlockedMove.changes, testTrash: trash)
    try c.expect(blockedByLink.errors.count == 1 && blockedByLink.changes.isEmpty, "undo cannot replace a dangling symlink")
    try c.expect(try manager.destinationOfSymbolicLink(atPath: linkBlockedSource.path) == "missing-occupant", "undo preserves dangling symlink occupant")
    try c.expect(try text(linkBlockedMove.succeeded[0]) == "original item", "undo link collision preserves moved contents")

    let partialGood = try file(source.appendingPathComponent("partial-good.txt"), "partial content")
    let missing = source.appendingPathComponent("does-not-exist")
    let partial = FileActions.transfer([partialGood, missing, renamed.destination], to: destination, move: false)
    try c.expect(partial.succeeded.count == 1 && partial.errors.count == 2 && partial.changes.count == 1, "partial copy reports successes and errors")
    try c.expect(try text(destination.appendingPathComponent("partial-good.txt")) == "partial content", "partial successful copy remains")
    try c.expect(exists(partialGood) && exists(renamed.destination), "partial copy preserves sources")
    let partialMoveGood = try file(source.appendingPathComponent("partial-move.txt"), "partial move content")
    let partialMove = FileActions.transfer([partialMoveGood, renamed.destination, missing], to: destination, move: true)
    try c.expect(partialMove.succeeded.count == 1 && partialMove.errors.count == 2 && partialMove.changes.count == 1, "partial move reports successes and errors")
    try c.expect(!exists(partialMoveGood) && exists(renamed.destination), "partial move only moves successful source")

    let trashOne = try file(source.appendingPathComponent("trash-me.txt"), "first trashed content")
    let trashTwo = try file(destination.appendingPathComponent("trash-me.txt"), "second trashed content")
    let trashed = FileActions.trash([trashOne, trashTwo, missing], testTrash: trash)
    try c.expect(trashed.succeeded.count == 2 && trashed.errors.count == 1 && trashed.changes.count == 2, "partial trash result")
    try c.expect(trashed.changes.allSatisfy { $0.kind == .trash }, "trash change kinds")
    try c.expect(!exists(trashOne) && !exists(trashTwo), "trash moves original entries")
    try c.expect(trashed.succeeded[0] != trashed.succeeded[1], "trash names do not collide")
    try c.expect(try text(trashed.succeeded[0]) == "first trashed content", "first trash content preserved")
    try c.expect(try text(trashed.succeeded[1]) == "second trashed content", "second trash content preserved")
    let restored = FileActions.undo(trashed.changes, testTrash: trash)
    try c.expect(restored.errors.isEmpty && restored.changes.count == 2, "undo trash restores both")
    try c.expect(try text(trashOne) == "first trashed content", "restored first trash content")
    try c.expect(try text(trashTwo) == "second trashed content", "restored second trash content")
    let trashedAgain = FileActions.trash([trashOne], testTrash: trash)
    _ = try file(trashOne, "replacement")
    let blockedTrashUndo = FileActions.undo(trashedAgain.changes, testTrash: trash)
    try c.expect(blockedTrashUndo.errors.count == 1 && blockedTrashUndo.changes.isEmpty, "undo trash collision rejected")
    try c.expect(try text(trashOne) == "replacement", "undo trash preserves replacement")
    try c.expect(try text(trashedAgain.succeeded[0]) == "first trashed content", "undo trash preserves trashed original")
    let linkTrash = FileActions.trash([brokenLink], testTrash: trash)
    try c.expect(linkTrash.errors.isEmpty && !exists(brokenLink), "trash broken symlink")
    try c.expect(try manager.destinationOfSymbolicLink(atPath: linkTrash.succeeded[0].path) == "absent-target", "trash preserves symlink object")
    try c.expect(FileActions.undo(linkTrash.changes, testTrash: trash).errors.isEmpty && exists(brokenLink), "undo broken symlink trash")

    let undoCopy = FileActions.undo(copied.changes, testTrash: trash)
    try c.expect(undoCopy.errors.isEmpty && undoCopy.changes.count == 1 && undoCopy.changes[0].kind == .trash, "undo copy goes to trash")
    try c.expect(!exists(copiedURL) && (try text(undoCopy.succeeded[0])) == "destination is different", "undo copy preserves subsequently changed content in trash")
    try c.expect(try text(renamed.destination) == "keep original", "undo copy does not touch original")
    let undoUndoCopy = FileActions.undo(undoCopy.changes, testTrash: trash)
    try c.expect(undoUndoCopy.errors.isEmpty && (try text(copiedURL)) == "destination is different", "inverse change can restore undone copy")
    let undoCreate = FileActions.undo([createdFolder, unicode], testTrash: trash)
    try c.expect(undoCreate.errors.isEmpty && undoCreate.changes.count == 2, "undo created file and folder")
    try c.expect(!exists(createdFolder.destination) && !exists(unicode.destination), "undo create vacates created paths")
    try c.expect(undoCreate.succeeded.allSatisfy { exists($0) }, "undo create keeps entries in test trash")
    let partialUndo = FileActions.undo([
      FileActionChange(source: nil, destination: missing, kind: .create),
      partial.changes[0]
    ], testTrash: trash)
    try c.expect(partialUndo.succeeded.count == 1 && partialUndo.errors.count == 1 && partialUndo.changes.count == 1, "partial undo reports success despite another failure")
    let missingOriginal = FileActions.undo([FileActionChange(source: nil, destination: renamed.destination, kind: .move)], testTrash: trash)
    try c.expect(missingOriginal.errors.count == 1 && exists(renamed.destination), "malformed undo record is rejected without mutation")

    let chainCreate = try FileActions.create(in: source, name: "chain.txt", directory: false)
    _ = try file(chainCreate.destination, "chain content")
    let chainRename = try FileActions.rename(chainCreate.destination, to: "chain-renamed.txt")
    let chainMove = FileActions.transfer([chainRename.destination], to: destination, move: true)
    try c.expect(chainMove.errors.isEmpty && chainMove.changes.count == 1, "chained move")
    let chainTrash = FileActions.trash(chainMove.succeeded, testTrash: trash)
    try c.expect(chainTrash.errors.isEmpty && chainTrash.changes.count == 1, "chained trash")
    let chainUndo = FileActions.undo([chainCreate, chainRename] + chainMove.changes + chainTrash.changes, testTrash: trash)
    try c.expect(chainUndo.errors.isEmpty && chainUndo.changes.count == 4, "cross-action undo runs in reverse order")
    try c.expect(!exists(chainCreate.destination) && !exists(chainRename.destination) && !exists(chainMove.succeeded[0]), "chain undo restores pre-create absence")
    try c.expect(try text(chainUndo.succeeded.last!) == "chain content", "chain undo retains contents in trash")

    // Test routing must not turn an arbitrary URL into a destructive test operation.
    let otherRoot = try directory(manager.temporaryDirectory.appendingPathComponent("ExplorerFileActionChecks-Other-\(UUID().uuidString)"))
    defer { try? manager.removeItem(at: otherRoot) }
    let otherFile = try file(otherRoot.appendingPathComponent("outside-fixture.txt"), "other fixture")
    try c.expect(FileActions.trash([otherFile], testTrash: trash).errors.count == 1, "test trash rejects other fixture subtree")
    try c.expect(try text(otherFile) == "other fixture", "rejected test routing leaves file untouched")
    let outsideAlias = try link(root.appendingPathComponent("other-fixture-alias"), target: otherRoot.path)
    try c.expect(FileActions.trash([outsideAlias.appendingPathComponent("outside-fixture.txt")], testTrash: trash).errors.count == 1, "test trash canonicalizes source parents")
    try c.expect(try text(otherFile) == "other fixture", "alias rejection leaves target untouched")
    let externalLink = try link(source.appendingPathComponent("external-target-link"), target: otherFile.path)
    let externalLinkTrash = FileActions.trash([externalLink], testTrash: trash)
    try c.expect(externalLinkTrash.errors.isEmpty && !exists(externalLink), "test trash allows fixture symlink object with external target")
    try c.expect(try text(otherFile) == "other fixture", "trashing symlink does not affect external target")
    try c.expect(FileActions.trash([renamed.destination], testTrash: manager.temporaryDirectory).errors.count == 1, "test trash rejects temporary root")
    try c.expect(FileActions.trash([renamed.destination], testTrash: root).errors.count == 1, "test trash rejects fixture root")
    try c.expect(FileActions.trash([renamed.destination], testTrash: renameBlocker).errors.count == 1, "test trash rejects nondirectory")
    try c.expect(try text(renamed.destination) == "keep original", "invalid test trash does not move source")
    let trashAlias = try link(root.appendingPathComponent("trash-alias"), target: trash.path)
    let aliasTrashSource = try file(source.appendingPathComponent("alias-trash.txt"), "alias trash")
    let aliasTrash = FileActions.trash([aliasTrashSource], testTrash: trashAlias)
    try c.expect(aliasTrash.errors.isEmpty && (try text(aliasTrash.succeeded[0])) == "alias trash", "test trash accepts safe canonical alias")

    // A path is not an undo identity: an external replacement must never be touched.
    let guardedCreate = try FileActions.create(in: source, name: "identity-create", directory: false)
    let savedCreate = root.appendingPathComponent("saved-created-item")
    try manager.moveItem(at: guardedCreate.destination, to: savedCreate)
    _ = try file(guardedCreate.destination, "replacement create")
    let refusedCreate = FileActions.undo([guardedCreate], testTrash: trash)
    try c.expect(refusedCreate.errors.count == 1 && refusedCreate.changes.isEmpty, "undo create rejects replaced destination")
    try c.expect(try text(guardedCreate.destination) == "replacement create", "undo create keeps replacement")
    let guardedCopy = FileActions.transfer([dotfile], to: destination, move: false)
    try c.expect(guardedCopy.errors.isEmpty, "prepare identity copy")
    let savedCopy = root.appendingPathComponent("saved-copied-item")
    try manager.moveItem(at: guardedCopy.succeeded[0], to: savedCopy)
    _ = try file(guardedCopy.succeeded[0], "replacement copy")
    try c.expect(FileActions.undo(guardedCopy.changes, testTrash: trash).errors.count == 1, "undo copy rejects replacement")
    try c.expect(try text(guardedCopy.succeeded[0]) == "replacement copy", "copy replacement retained")
    let guardedMoveSource = try file(source.appendingPathComponent("identity-move"), "actual move")
    let guardedMove = FileActions.transfer([guardedMoveSource], to: destination, move: true)
    let savedMove = root.appendingPathComponent("saved-moved-item")
    try manager.moveItem(at: guardedMove.succeeded[0], to: savedMove)
    _ = try file(guardedMove.succeeded[0], "replacement move")
    try c.expect(FileActions.undo(guardedMove.changes, testTrash: trash).errors.count == 1, "undo move rejects replacement")
    try c.expect(!exists(guardedMoveSource) && (try text(guardedMove.succeeded[0])) == "replacement move", "undo move leaves replacement in place")
    let guardedTrashSource = try file(source.appendingPathComponent("identity-trash"), "actual trash")
    let guardedTrash = FileActions.trash([guardedTrashSource], testTrash: trash)
    try manager.moveItem(at: guardedTrash.succeeded[0], to: root.appendingPathComponent("saved-trashed-item"))
    _ = try file(guardedTrash.succeeded[0], "replacement trash")
    try c.expect(FileActions.undo(guardedTrash.changes, testTrash: trash).errors.count == 1, "undo trash rejects replacement")
    try c.expect(!exists(guardedTrashSource) && (try text(guardedTrash.succeeded[0])) == "replacement trash", "trash replacement preserved")
    let retrySource = try file(source.appendingPathComponent("retry-undo"), "retry content")
    let retryMove = FileActions.transfer([retrySource], to: destination, move: true)
    _ = try file(retrySource, "temporary blocker")
    try c.expect(FileActions.undo(retryMove.changes, testTrash: trash).errors.count == 1, "first undo attempt blocked")
    try manager.removeItem(at: retrySource)
    try c.expect(FileActions.undo(retryMove.changes, testTrash: trash).errors.isEmpty, "same record retries after collision removed")
    try c.expect(try text(retrySource) == "retry content", "retry restores original content")
    let future = destination.appendingPathComponent("not-yet-created")
    let invalidFuture = FileActionChange(source: nil, destination: future, kind: .create)
    _ = try file(future, "later unrelated file")
    try c.expect(FileActions.undo([invalidFuture], testTrash: trash).errors.count == 1, "missing identity cannot attach to later file")
    try c.expect(try text(future) == "later unrelated file", "later file preserved")
    let identityLink = try link(source.appendingPathComponent("identity-link"), target: "missing-old")
    let linkRename = try FileActions.rename(identityLink, to: "identity-link-renamed")
    try manager.moveItem(at: linkRename.destination, to: root.appendingPathComponent("saved-identity-link"))
    _ = try link(linkRename.destination, target: "missing-new")
    try c.expect(FileActions.undo([linkRename], testTrash: trash).errors.count == 1, "undo compares symlink object identity")
    try c.expect(try manager.destinationOfSymbolicLink(atPath: linkRename.destination.path) == "missing-new", "replacement link untouched")

    // Protected-location preflight is read-only; never attempt a real system mutation in checks.
    for protected in ["/", "/System", "/Library", "/Applications", "/Users", manager.homeDirectoryForCurrentUser.path] {
      try c.rejects("system location modification preflight") { try FileActions.validateModificationSource(URL(fileURLWithPath: protected)) }
    }
    try FileActions.validateModificationSource(renamed.destination)
    let userLink = try link(source.appendingPathComponent("protected-target-link"), target: manager.homeDirectoryForCurrentUser.path)
    let copiedUserLink = FileActions.transfer([userLink], to: destination, move: false)
    try c.expect(copiedUserLink.errors.isEmpty && copiedUserLink.changes.count == 1, "copying a link to a protected folder copies only the link object")
    let renamedUserLink = try FileActions.rename(userLink, to: "protected-target-renamed")
    try c.expect(try manager.destinationOfSymbolicLink(atPath: renamedUserLink.destination.path) == manager.homeDirectoryForCurrentUser.path, "renaming a user symlink never renames its protected target")
    let trashedUserLink = FileActions.trash([renamedUserLink.destination], testTrash: trash)
    try c.expect(trashedUserLink.errors.isEmpty && (try manager.destinationOfSymbolicLink(atPath: trashedUserLink.succeeded[0].path)) == manager.homeDirectoryForCurrentUser.path, "trashing a user symlink moves only the symlink")
    let protectedParentAlias = try link(root.appendingPathComponent("protected-parent-alias"), target: manager.homeDirectoryForCurrentUser.deletingLastPathComponent().path)
    try c.rejects("protected directories cannot be modified through a parent alias") { try FileActions.validateModificationSource(protectedParentAlias.appendingPathComponent(manager.homeDirectoryForCurrentUser.lastPathComponent)) }
    try c.expect(FileActions.transfer([], to: destination, move: false).changes.isEmpty, "empty transfer")
    try c.expect(FileActions.trash([], testTrash: trash).errors.isEmpty, "empty trash")
    try c.expect(FileActions.undo([], testTrash: trash).succeeded.isEmpty, "empty undo")
  }
}
