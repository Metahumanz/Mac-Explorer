import Foundation
import Darwin

public enum DeletionVolume: Sendable { case local, network }

/// All operational classification uses the opened, resolved parent. Menu hints are not authority.
public final class PreparedDeletion: @unchecked Sendable {
  public let source: URL
  public let volume: DeletionVolume
  public let network: NetworkDeletion?
  private let anchor: DeletionAnchor
  private init(_ source: URL, budget: DeletionBudget, classifier: @escaping DeletionClassifier) throws {
    self.source = source
    anchor = try DeletionAnchor(source, classifier: classifier)
    volume = anchor.volume
    network = volume == .network ? try NetworkDeletion(anchor: anchor, budget: budget) : nil
  }
  public static func prepare(_ sources: [URL]) throws -> [PreparedDeletion] {
    try batch(sources, classifier: { fd in try DeletionAnchor.volume(fd) })
  }
  private static func batch(_ sources: [URL], classifier: @escaping DeletionClassifier, limits: DeletionLimits = .init()) throws -> [PreparedDeletion] {
    guard !sources.isEmpty, sources.count <= limits.topLevel else { throw deletionError(sources.first ?? URL(fileURLWithPath: "/"), E2BIG) }
    let budget = DeletionBudget(limits)
    let plans = try sources.map { try PreparedDeletion($0, budget: budget, classifier: classifier) }
    guard Set(plans.map { $0.anchor.source.path }).count == plans.count else { throw deletionError(sources[0], EINVAL) }
    return plans
  }
  /// Recheck immediately before calling the path-based system Trash API. This is not atomic with that API.
  public func validateForRecycle() throws -> URL {
    guard volume == .local else { throw deletionError(source, EPERM) }
    try anchor.validate(); return anchor.source
  }
#if EXPLORER_DELETION_TESTS
  /// Compiled only into validation builds. Even fixture classifiers cannot authorize a remote FD.
  public static func fixtures(_ sources: [URL], root: URL, classification: @escaping @Sendable (URL) -> DeletionVolume?, maximumEntries: Int = 50_000, maximumDepth: Int = 128) throws -> [PreparedDeletion] {
    try fixtureRoot(root, sources: sources)
    var limits = DeletionLimits(); limits.entries = maximumEntries; limits.depth = maximumDepth
    // Resolve the actual FD path, so an alias cannot be classified using its lexical prefix.
    return try batch(sources, classifier: { fd in
      guard try DeletionAnchor.volume(fd) == .local else { throw deletionError(root, EPERM) }
      var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
      guard fcntl(fd, F_GETPATH, &path) == 0 else { throw deletionError(root) }
      return classification(URL(fileURLWithPath: String(cString: path)))
    }, limits: limits)
  }
  private static func fixtureRoot(_ root: URL, sources: [URL]) throws {
    let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
    let resolved = root.resolvingSymlinksInPath()
    let prefixes = ["network-delete-check-", "native-network-delete-"]
    guard resolved.deletingLastPathComponent().path == temporary.path,
      prefixes.contains(where: { resolved.lastPathComponent.hasPrefix($0) && UUID(uuidString: String(resolved.lastPathComponent.dropFirst($0.count))) != nil }),
      sources.allSatisfy({ $0.standardizedFileURL.deletingLastPathComponent().resolvingSymlinksInPath().path.hasPrefix(resolved.path + "/") || $0.standardizedFileURL.deletingLastPathComponent().resolvingSymlinksInPath().path == resolved.path }) else { throw deletionError(root, EPERM) }
  }
#endif
}

public struct NetworkDeletionOutcome: Sendable {
  public let deletedEntries: Int
  public let rootRemoved: Bool
  public var mutated: Bool { deletedEntries > 0 }
}
public struct NetworkDeletionFailure: Error, CustomNSError, LocalizedError {
  public let underlying: Error
  public let outcome: NetworkDeletionOutcome
  public static var errorDomain: String { "NetworkDeletion" }
  public var errorCode: Int { (underlying as NSError).code }
  public var errorUserInfo: [String: Any] {
    var info = (underlying as NSError).userInfo
    info[NSUnderlyingErrorKey] = underlying; info[NSLocalizedDescriptionKey] = underlying.localizedDescription
    return info
  }
  public var errorDescription: String? { underlying.localizedDescription }
}

/// A bounded confirmation manifest. It never contains file content or creates NAS staging files.
public final class NetworkDeletion: @unchecked Sendable {
  public var source: URL { anchor.source }
  private let anchor: DeletionAnchor
  private let manifest: DeletionNode
  private let limits: DeletionLimits
  private let lock = NSLock()
  private var consumed = false
  fileprivate init(anchor: DeletionAnchor, budget: DeletionBudget) throws {
    self.anchor = anchor; limits = budget.limits
    manifest = try Self.capture(anchor.descriptor, anchor.source.lastPathComponent, anchor.source, anchor: anchor, budget: budget, depth: 0)
  }
  public convenience init(_ source: URL) throws {
    let anchor = try DeletionAnchor(source, classifier: { try DeletionAnchor.volume($0) })
    guard anchor.volume == .network else { throw deletionError(source, EPERM) }
    try self.init(anchor: anchor, budget: DeletionBudget(.init()))
  }
  @discardableResult public func remove() throws -> NetworkDeletionOutcome {
    lock.lock(); let already = consumed; consumed = true; lock.unlock()
    var count = 0, rootRemoved = false
    do {
      guard !already else { throw deletionError(source, ESTALE) }
      try anchor.validate()
      let budget = DeletionBudget(limits)
      // Validate the whole manifest before the first unlink. This is not a filesystem transaction.
      try verify(anchor.descriptor, manifest, source, budget: budget, depth: 0)
      try walk(anchor.descriptor, manifest, source, budget: DeletionBudget(limits), depth: 0, count: &count, rootRemoved: &rootRemoved)
      return NetworkDeletionOutcome(deletedEntries: count, rootRemoved: true)
    } catch { throw NetworkDeletionFailure(underlying: error, outcome: NetworkDeletionOutcome(deletedEntries: count, rootRemoved: rootRemoved)) }
  }
  private static func capture(_ parent: Int32, _ name: String, _ path: URL, anchor: DeletionAnchor, budget: DeletionBudget, depth: Int) throws -> DeletionNode {
    try budget.visit(path, depth: depth)
    let before = try stamp(parent, name, path)
    guard before.device == anchor.original.device else { throw deletionError(path, EXDEV) }
    var children: [DeletionNode] = []
    if before.type == S_IFDIR {
      let fd = try directory(parent, name, path, expected: before, anchor: anchor); defer { Darwin.close(fd) }
      for child in try names(fd, path, budget: budget) { children.append(try capture(fd, child, path.appendingPathComponent(child), anchor: anchor, budget: budget, depth: depth + 1)) }
      guard before.unchanged(try stamp(parent, name, path)), Set(try names(fd, path, budget: budget)) == Set(children.map(\.name)) else { throw deletionError(path, ESTALE) }
    }
    return DeletionNode(name: name, original: before, children: children)
  }
  private func verify(_ parent: Int32, _ node: DeletionNode, _ path: URL, budget: DeletionBudget, depth: Int) throws {
    try budget.visit(path, depth: depth)
    let before = try Self.stamp(parent, node.name, path)
    guard node.original.sameObject(before) else { throw deletionError(path, ESTALE) }
    if node.original.type == S_IFDIR {
      let fd = try Self.directory(parent, node.name, path, expected: node.original, anchor: anchor); defer { Darwin.close(fd) }
      guard node.original.unchanged(before) else { throw deletionError(path, ESTALE) }
      guard Set(try Self.names(fd, path, budget: budget)) == Set(node.children.map(\.name)) else { throw deletionError(path, ESTALE) }
      for child in node.children { try verify(fd, child, path.appendingPathComponent(child.name), budget: budget, depth: depth + 1) }
      guard node.original.unchanged(try Self.stamp(parent, node.name, path)) else { throw deletionError(path, ESTALE) }
    } else if !node.original.unchanged(before) { throw deletionError(path, ESTALE) }
  }
  private func walk(_ parent: Int32, _ node: DeletionNode, _ path: URL, budget: DeletionBudget, depth: Int, count: inout Int, rootRemoved: inout Bool) throws {
    try budget.visit(path, depth: depth); try anchor.validateParent()
    let before = try Self.stamp(parent, node.name, path)
    guard node.original.sameObject(before) else { throw deletionError(path, ESTALE) }
    if node.original.type == S_IFDIR {
      let fd = try Self.directory(parent, node.name, path, expected: node.original, anchor: anchor); defer { Darwin.close(fd) }
      guard node.original.unchanged(before) else { throw deletionError(path, ESTALE) }
      guard Set(try Self.names(fd, path, budget: budget)) == Set(node.children.map(\.name)) else { throw deletionError(path, ESTALE) }
      // Visit only confirmed names. A concurrent new name is preserved and prevents final rmdir.
      for child in node.children { try walk(fd, child, path.appendingPathComponent(child.name), budget: budget, depth: depth + 1, count: &count, rootRemoved: &rootRemoved) }
      guard try Self.names(fd, path, budget: budget).isEmpty else { throw deletionError(path, ESTALE) }
    }
    try anchor.validateParent()
    let final = try Self.stamp(parent, node.name, path)
    guard node.original.type == S_IFDIR ? node.original.sameObject(final) : node.original.unchanged(final) else { throw deletionError(path, ESTALE) }
#if EXPLORER_DELETION_TESTS
    try auditHook?(.beforeUnlink, path)
#endif
    // POSIX has no atomic "unlink only if this inode still matches". Keep this residual race explicit.
    guard unlinkat(parent, node.name, node.original.type == S_IFDIR ? AT_REMOVEDIR : 0) == 0 else { throw deletionError(path) }
    count += 1; if depth == 0 { rootRemoved = true }
#if EXPLORER_DELETION_TESTS
    try auditHook?(.afterUnlink, path)
#endif
  }
  private static func directory(_ parent: Int32, _ name: String, _ path: URL, expected: TransferStamp, anchor: DeletionAnchor) throws -> Int32 {
    let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw deletionError(path) }
    do {
      var info = stat(); guard fstat(fd, &info) == 0 else { throw deletionError(path) }
      guard expected.sameObject(TransferStamp(info)) else { throw deletionError(path, ESTALE) }
      try anchor.validateMount(fd); return fd
    } catch { Darwin.close(fd); throw error }
  }
  private static func names(_ fd: Int32, _ path: URL, budget: DeletionBudget) throws -> [String] {
    let duplicate = fcntl(fd, F_DUPFD_CLOEXEC, 0); guard duplicate >= 0 else { throw deletionError(path) }
    guard let stream = fdopendir(duplicate) else { let code = errno; Darwin.close(duplicate); throw deletionError(path, code) }
    defer { closedir(stream) }
    // dup shares its directory offset with fd; every complete membership read starts at the beginning.
    rewinddir(stream)
    var values: [String] = []
    while true {
      errno = 0
      guard let entry = readdir(stream) else { if errno != 0 { throw deletionError(path) }; break }
      let name = withUnsafePointer(to: &entry.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(NAME_MAX) + 1) { String(validatingUTF8: $0) } }
      guard let name else { throw deletionError(path, EILSEQ) }
      if name != "." && name != ".." { values.append(name) }
      guard values.count <= budget.limits.entries else { throw deletionError(path, E2BIG) }; try budget.check(path)
    }
    return values.sorted()
  }
  private static func stamp(_ fd: Int32, _ name: String, _ path: URL) throws -> TransferStamp {
    var info = stat(); guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw deletionError(path) }; return TransferStamp(info)
  }
#if EXPLORER_DELETION_TESTS
  public enum AuditStage { case beforeUnlink, afterUnlink }
  public var auditHook: ((AuditStage, URL) throws -> Void)?
#endif
}

private typealias DeletionClassifier = @Sendable (Int32) throws -> DeletionVolume?
private struct DeletionLimits {
  var topLevel = 64, entries = 50_000, depth = 128, pathBytes = 16 * 1024 * 1024
  var seconds: Double = 60
}
private final class DeletionBudget {
  let limits: DeletionLimits
  private var entries = 0, bytes = 0
  private let deadline: TimeInterval
  init(_ limits: DeletionLimits) { self.limits = limits; deadline = ProcessInfo.processInfo.systemUptime + limits.seconds }
  func check(_ path: URL) throws {
    try Task.checkCancellation()
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw deletionError(path, ETIMEDOUT) }
  }
  func visit(_ path: URL, depth: Int) throws {
    try check(path); entries += 1; bytes += path.path.utf8.count
    guard depth < limits.depth else { throw deletionError(path, ELOOP) }
    guard entries <= limits.entries, bytes <= limits.pathBytes else { throw deletionError(path, E2BIG) }
  }
}
private struct DeletionNode { let name: String; let original: TransferStamp; let children: [DeletionNode] }

private final class DeletionAnchor: @unchecked Sendable {
  let source: URL, requestedParent: URL, parent: URL, descriptor: Int32, original: TransferStamp, parentIdentity: TransferStamp, volume: DeletionVolume
  private let fsid: fsid_t, classifier: DeletionClassifier
  init(_ input: URL, classifier: @escaping DeletionClassifier) throws {
    guard input.isFileURL, input.baseURL == nil, input.user == nil, input.password == nil, input.port == nil,
      input.host == nil || input.host == "" || input.host == "localhost", input.query == nil, input.fragment == nil,
      input.path.hasPrefix("/"), !input.path.contains("\0"), input.standardizedFileURL.path != "/" else { throw deletionError(input, EINVAL) }
    try FileActions.validateModificationSource(input)
    requestedParent = input.standardizedFileURL.deletingLastPathComponent(); parent = try resolvedDeletionDirectory(requestedParent)
    source = parent.appendingPathComponent(input.standardizedFileURL.lastPathComponent, isDirectory: false)
    let fd = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); guard fd >= 0 else { throw deletionError(input) }
    do {
      var info = stat(), entry = stat(), mount = statfs()
      guard fstat(fd, &info) == 0 else { throw deletionError(input) }
      guard fstatfs(fd, &mount) == 0 else { throw deletionError(input) }
      guard fstatat(fd, source.lastPathComponent, &entry, AT_SYMLINK_NOFOLLOW) == 0 else { throw deletionError(input) }
      guard let kind = try classifier(fd) else { throw deletionError(input, ENXIO) }
      guard entry.st_dev == info.st_dev else { throw deletionError(input, EXDEV) }
      descriptor = fd; original = TransferStamp(entry); parentIdentity = TransferStamp(info); volume = kind; fsid = mount.f_fsid; self.classifier = classifier
    } catch { Darwin.close(fd); throw error }
  }
  deinit { Darwin.close(descriptor) }
  static func volume(_ fd: Int32) throws -> DeletionVolume {
    var mount = statfs(); guard fstatfs(fd, &mount) == 0 else { throw deletionError(URL(fileURLWithPath: "/")) }
    return mount.f_flags & UInt32(MNT_LOCAL) == 0 ? .network : .local
  }
  func validate() throws {
    try validateParent()
    var info = stat(); guard fstatat(descriptor, source.lastPathComponent, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw deletionError(source) }
    guard original.sameObject(TransferStamp(info)) else { throw deletionError(source, ESTALE) }
  }
  func validateParent() throws {
    var info = stat()
    guard lstat(parent.path, &info) == 0 else { throw deletionError(source) }
    guard try resolvedDeletionDirectory(requestedParent).path == parent.path, parentIdentity.sameObject(TransferStamp(info)) else { throw deletionError(source, ESTALE) }
    try validateMount(descriptor)
  }
  func validateMount(_ fd: Int32) throws {
    var mount = statfs(); guard fstatfs(fd, &mount) == 0 else { throw deletionError(source) }
    guard let kind = try classifier(fd) else { throw deletionError(source, ENXIO) }
    guard kind == volume, mount.f_fsid.val.0 == fsid.val.0, mount.f_fsid.val.1 == fsid.val.1 else { throw deletionError(source, ESTALE) }
  }
}
private func deletionError(_ path: URL, _ code: Int32 = errno) -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(code), userInfo: [NSFilePathErrorKey: path.path]) }

private func resolvedDeletionDirectory(_ url: URL) throws -> URL {
  guard let resolved = realpath(url.path, nil) else { throw deletionError(url) }
  defer { free(resolved) }
  guard let path = String(validatingUTF8: resolved) else { throw deletionError(url, EILSEQ) }
  return URL(fileURLWithPath: path, isDirectory: true)
}
