import Foundation
import Darwin

private final class FixtureCopier: ServerSideCopyProvider, @unchecked Sendable {
  enum Behavior { case success, fallback, cancelled, failed, uncertain, replaced, changedSource }
  let behavior: Behavior
  var calls = 0
  var bytes: [String: Data] = [:]
  init(_ behavior: Behavior = .success) { self.behavior = behavior }
  func isCandidate(source: URL, destination: URL) -> Bool { true }
  func copy(sourceDescriptor: Int32, destinationDescriptor: Int32, source: URL, destination: URL, control: FileTransferControl) throws -> Bool {
    calls += 1
    if behavior == .fallback { return false }
    let content = bytes[source.lastPathComponent] ?? Data("test-data".utf8)
    let count = content.withUnsafeBytes { pwrite(destinationDescriptor, $0.baseAddress, content.count, 0) }
    guard count == content.count else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    control.reportServerSideProgress(source, completed: Int64(count), total: Int64(count))
    if behavior == .cancelled { control.cancel(); throw CancellationError() }
    if behavior == .failed { throw ServerSideCopyError.failed(ENOSPC) }
    if behavior == .uncertain { throw ServerSideCopyError.uncertain(ETIMEDOUT) }
    if behavior == .replaced {
      try FileManager.default.moveItem(at: destination, to: destination.appendingPathExtension("owned"))
      try Data("intruder!".utf8).write(to: destination, options: .withoutOverwriting)
    }
    if behavior == .changedSource { try Data("changed!!".utf8).write(to: source) }
    return true
  }
}

@main struct ServerSideTransferChecks {
  static func main() throws {
    var count = 0
    func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
      guard try value() else { throw NSError(domain: "ServerSideChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }; count += 1
    }
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("explorer-server-side-checks-" + UUID().uuidString)
    try fm.createDirectory(at: root, withIntermediateDirectories: false)
    defer { try? fm.removeItem(at: root) }
    func location(_ mount: String, _ source: String, _ path: String, _ fs: String = "smbfs") -> SMBMountedLocation? {
      SMBMountedLocation(root: URL(fileURLWithPath: mount), mountSource: source, filesystem: fs, file: URL(fileURLWithPath: path))
    }
    let a = location("/fixture/A", "//user@NAS/Share%20A", "/fixture/A/中文 1.txt")!
    let b = location("/fixture/B", "//user@nas/ShareB", "/fixture/B/dest")!
    try expect(a.canTransfer(to: b), "Exact same server/account, distinct shares qualify")
    try expect(a.remotePath == "中文 1.txt" && a.share == "Share A", "Unicode filenames and share escapes retain exact components")
    try expect(!a.canTransfer(to: location("/fixture/B", "//other@nas/ShareB", "/fixture/B/dest")!), "Different mounted users never qualify")
    try expect(!a.canTransfer(to: location("/fixture/B", "//user@alias/ShareB", "/fixture/B/dest")!), "Aliases never infer a common server")
    try expect(!a.canTransfer(to: location("/fixture/B", "//user@nas:1445/ShareB", "/fixture/B/dest")!), "Different ports never qualify")
    try expect(!a.canTransfer(to: location("/fixture/B", "//user@nas/share%20a", "/fixture/B/dest")!), "Two mounts of one share are not cross-share optimization candidates")
    try expect(location("/fixture/A", "//user@nas/A", "/fixture/AB/escape") == nil, "Mount-prefix lookalikes cannot escape")
    try expect(location("/fixture/A", "//user@nas/A", "/fixture/A/../escape") == nil, "Dot traversal is rejected")
    try expect(location("/fixture/A", "//user@nas/A", "/fixture/A/file:stream") == nil, "Alternate stream syntax is rejected")
    for fs in ["apfs", "nfs", "webdav", "smb"] {
      try expect(location("/fixture/A", "//user@nas/A", "/fixture/A/file", fs) == nil, "Only smbfs is eligible")
    }
    for source in ["//user:password@nas/A", "//user@nas/A%2FB", "//user@nas/A?x=1", "//user@nas/A#fragment", "//user@nas/A/..", "//user@nas/A//child", "//user@nas/A/subdir", "//us%00er@nas/A"] {
      try expect(location("/fixture/A", source, "/fixture/A/file") == nil, "Ambiguous/credential-bearing mount source is rejected")
    }
    let ipv6 = location("/fixture/A", "//user@[2001:db8::1]:1445/A", "/fixture/A/file")
    try expect(ipv6?.authority == "[2001:db8::1]:1445", "IPv6 authority retains unambiguous port")

    func fixture(_ name: String, behavior: FixtureCopier.Behavior, move: Bool = true) throws -> (URL, URL, FixtureCopier, FileActionResult, [FileTransferProgress]) {
      let folder = root.appendingPathComponent(name)
      let from = folder.appendingPathComponent("source"), target = folder.appendingPathComponent("target")
      try fm.createDirectory(at: from, withIntermediateDirectories: true); try fm.createDirectory(at: target, withIntermediateDirectories: false)
      let file = from.appendingPathComponent("file.txt")
      try Data("test-data".utf8).write(to: file)
      let attribute = Data("stream-fixture".utf8)
      guard attribute.withUnsafeBytes({ setxattr(file.path, "com.apple.ResourceFork", $0.baseAddress, $0.count, 0, 0) }) == 0 else { throw VerifiedTransfer.posix() }
      let chmod = Process(); chmod.executableURL = URL(fileURLWithPath: "/bin/chmod"); chmod.arguments = ["+a", "everyone allow read", file.path]
      try chmod.run(); chmod.waitUntilExit(); guard chmod.terminationStatus == 0 else { throw VerifiedTransfer.posix(EACCES) }
      try fm.setAttributes([.creationDate: Date(timeIntervalSince1970: 1_600_000_000), .modificationDate: Date(timeIntervalSince1970: 1_650_000_000)], ofItemAtPath: file.path)
      let copier = FixtureCopier(behavior); var progress: [FileTransferProgress] = []
      let control = FileTransferControl(onProgress: { progress.append($0) }, serverSideCopy: copier)
      var hooks = TransferHooks(); hooks.forceCopyMove = true; hooks.control = control
      let result = FileActions.transfer([file], to: target, move: move, hooks: hooks)
      return (file, target, copier, result, progress)
    }
    let (copiedSource, copiedTarget, copy, copied, copyProgress) = try fixture("copy", behavior: .success, move: false)
    try expect(copied.errors.isEmpty && copy.calls == 1 && copied.transfers.first?.method == .serverSideCopy, "Data-only provider integrates with the common transfer path")
    try expect(try Data(contentsOf: copiedTarget.appendingPathComponent("file.txt")) == Data(contentsOf: copiedSource), "Metadata-only fcopyfile leaves offloaded bytes intact")
    try expect(copied.transfers.first?.datesVerified == true && copied.transfers.first?.contentVerified == false, "Dates are verified without claiming a content hash")
    try expect(copyProgress.contains { $0.mode == .serverSide && $0.completedBytes == 9 }, "Server-reported progress reaches the existing control")
    let copiedFile = copiedTarget.appendingPathComponent("file.txt")
    let resourceLength = getxattr(copiedFile.path, "com.apple.ResourceFork", nil, 0, 0, 0)
    var resource = [UInt8](repeating: 0, count: max(0, resourceLength))
    let readResource = resource.withUnsafeMutableBytes { getxattr(copiedFile.path, "com.apple.ResourceFork", $0.baseAddress, $0.count, 0, 0) }
    try expect(readResource == resourceLength && Data(resource) == Data("stream-fixture".utf8), "Metadata-only copy retains resource-fork content")
    let originalFD = open(copiedSource.path, O_RDONLY), copiedFD = open(copiedFile.path, O_RDONLY)
    defer { close(originalFD); close(copiedFD) }
    let originalACL = try NativeTransferCopy.explicitACL(originalFD), copiedACL = try NativeTransferCopy.explicitACL(copiedFD)
    try expect(originalACL != nil && originalACL == copiedACL, "Metadata-only copy preserves the source explicit ACL")
    var copiedStat = stat(); _ = stat(copiedTarget.appendingPathComponent("file.txt").path, &copiedStat)
    try expect(copiedStat.st_birthtimespec.tv_sec == 1_600_000_000 && copiedStat.st_mtimespec.tv_sec == 1_650_000_000, "Original creation and modification dates survive offload")

    let (movedSource, movedTarget, _, moved, _) = try fixture("move", behavior: .success)
    try expect(moved.errors.isEmpty && !fm.fileExists(atPath: movedSource.path) && fm.fileExists(atPath: movedTarget.appendingPathComponent("file.txt").path), "Move removes its source only after normal verification")
    let undone = FileActions.undo(moved.changes)
    try expect(undone.errors.isEmpty && fm.fileExists(atPath: movedSource.path), "Completed optimized moves remain reversible through common undo")
    let (fallbackSource, fallbackTarget, fallback, ordinary, ordinaryProgress) = try fixture("fallback", behavior: .fallback)
    try expect(ordinary.errors.isEmpty && fallback.calls == 1 && ordinary.transfers.first?.method == .systemCopy, "Confirmed unsupported transport falls back once")
    try expect(!fm.fileExists(atPath: fallbackSource.path) && (try Data(contentsOf: fallbackTarget.appendingPathComponent("file.txt"))) == Data("test-data".utf8), "Fallback preserves ordinary copy-then-delete semantics")
    try expect(ordinaryProgress.allSatisfy { $0.mode == .system }, "Fallback never reports server-side progress")

    for behavior in [FixtureCopier.Behavior.cancelled, .failed, .uncertain, .replaced, .changedSource] {
      let (source, target, provider, result, _) = try fixture("failure-\(behavior)", behavior: behavior)
      try expect(provider.calls == 1 && result.succeeded.isEmpty && fm.fileExists(atPath: source.path), "Failed/cancelled offload never deletes its source or retries data automatically")
      let leftovers = try fm.contentsOfDirectory(at: target, includingPropertiesForKeys: nil)
      if behavior == .uncertain {
        try expect(result.transfers.first?.outcome == .cleanupIncomplete && !leftovers.isEmpty && result.transfers.first?.recoveryLocations.isEmpty == false, "Uncertain in-flight status preserves and reports the target tree")
        let stage = leftovers.first { $0.lastPathComponent.hasPrefix(".mac-explorer-transfer-") }!
        try expect(try Data(contentsOf: stage.appendingPathComponent("payload")) == Data("test-data".utf8), "Uncertain target is not cleaned by generic rollback")
      } else if behavior == .replaced {
        try expect(result.transfers.first?.recoveryLocations.isEmpty == false, "Replacement is preserved and reported")
      } else { try expect(leftovers.isEmpty, "Acknowledged failure/cancel cleans only owned destinations") }
    }

    for unknownChild in [false, true] {
      let folder = root.appendingPathComponent("direct-uncertain-\(unknownChild)")
      let source = folder.appendingPathComponent("source"), target = folder.appendingPathComponent("target")
      try fm.createDirectory(at: source, withIntermediateDirectories: true)
      try fm.createDirectory(at: target, withIntermediateDirectories: false)
      let file = source.appendingPathComponent("file.txt"), output = target.appendingPathComponent("file.txt")
      try Data("test-data".utf8).write(to: file)
      var stage: URL?
      var hooks = TransferHooks(); hooks.forceCopyMove = true
      hooks.exclusiveRename = { _, _ in throw VerifiedTransfer.posix(ENOTSUP) }
      hooks.control = FileTransferControl(serverSideCopy: FixtureCopier(.uncertain))
      hooks.checkpoint = { point, _, _ in
        if point == .beforeCopy {
          stage = try fm.contentsOfDirectory(at: target, includingPropertiesForKeys: nil).first { $0.lastPathComponent.hasPrefix(".mac-explorer-transfer-") }
          if unknownChild, let stage { try Data("external".utf8).write(to: stage.appendingPathComponent("payload")) }
        }
      }
      let result = FileActions.transfer([file], to: target, move: true, hooks: hooks)
      try expect(result.transfers.first?.outcome == .cleanupIncomplete && fm.fileExists(atPath: file.path), "Uncertain direct copy keeps its source and outcome")
      try expect(try Data(contentsOf: output) == Data("test-data".utf8), "Uncertain direct target is never rolled back")
      try expect(result.transfers.first?.recoveryLocations.contains(output) == true, "Uncertain direct output is reported")
      if unknownChild {
        try expect(try Data(contentsOf: stage!.appendingPathComponent("payload")) == Data("external".utf8), "Uncertain cleanup never traverses unknown stage contents")
        try expect(result.transfers.first?.recoveryLocations.contains(stage!) == true, "Nonempty unused stage is also reported for recovery")
      } else {
        try expect(!fm.fileExists(atPath: stage!.path) && (try fm.contentsOfDirectory(atPath: target.path)) == ["file.txt"], "Uncertain direct copy removes only its unused empty stage")
      }
    }

    let directory = root.appendingPathComponent("tree"), destination = root.appendingPathComponent("tree-target")
    try fm.createDirectory(at: directory.appendingPathComponent("child"), withIntermediateDirectories: true)
    try fm.createDirectory(at: destination, withIntermediateDirectories: false)
    try Data("test-data".utf8).write(to: directory.appendingPathComponent("child/nonempty"))
    try Data().write(to: directory.appendingPathComponent("empty"))
    try fm.createSymbolicLink(atPath: directory.appendingPathComponent("link").path, withDestinationPath: "child/nonempty")
    let provider = FixtureCopier(); var modes: [FileTransferMode] = []
    let control = FileTransferControl(onProgress: { modes.append($0.mode) }, serverSideCopy: provider)
    let tree = FileActions.transfer([directory], to: destination, move: false, control: control)
    try expect(tree.errors.isEmpty && provider.calls == 1, "Directory recursion offloads regular nonempty files only")
    try expect(try fm.destinationOfSymbolicLink(atPath: destination.appendingPathComponent("tree/link").path) == "child/nonempty", "Symbolic links remain links")
    try expect(modes.contains(.serverSide) && modes.contains(.system), "Mixed tree progress switches modes correctly")
    let noOp = FileActions.transfer([directory], to: root, move: true, control: control)
    try expect(noOp.errors.isEmpty && provider.calls == 1 && noOp.transfers.first?.method == .noOp, "Same-folder moves bypass the offload backend")
    control.cancel()
    let cancelled = FileActions.transfer([directory], to: destination, move: false, control: control)
    try expect(cancelled.succeeded.isEmpty && provider.calls == 1, "Pre-cancelled operations never invoke the transport")
    print("ServerSideTransferChecks: \(count) passed")
  }
}
