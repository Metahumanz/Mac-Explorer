import Foundation
import Darwin

public enum FileTransferDecision: Sendable { case retry, skip, cancel, keepBoth, continueWithoutProperties }
public struct FileTransferProblem: Sendable {
  public let source: URL
  public let destination: URL
  public let message: String
  public let propertyLoss: Bool
  public var moving: Bool = false
  public var collision: Bool = false
  public init(source: URL, destination: URL, message: String, propertyLoss: Bool, moving: Bool = false, collision: Bool = false) {
    self.source = source; self.destination = destination; self.message = message; self.propertyLoss = propertyLoss; self.moving = moving; self.collision = collision
  }
}
public struct FileTransferProgress: Sendable {
  public let source: URL
  public let completedBytes: Int64
  public let totalBytes: Int64
  public init(source: URL, completedBytes: Int64, totalBytes: Int64) { self.source = source; self.completedBytes = completedBytes; self.totalBytes = totalBytes }
}

/// One user operation, shared by its background worker and window. Never process-global.
public final class FileTransferControl: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private var lastProgress = Date.distantPast
  private var lastSource: URL?
  private let onProblem: ((FileTransferProblem) -> FileTransferDecision)?
  private let onProgress: ((FileTransferProgress) -> Void)?
  public init(onProblem: ((FileTransferProblem) -> FileTransferDecision)? = nil, onProgress: ((FileTransferProgress) -> Void)? = nil) {
    self.onProblem = onProblem; self.onProgress = onProgress
  }
  public func cancel() { lock.lock(); cancelled = true; lock.unlock() }
  public var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
  func check() throws { if isCancelled { throw CancellationError() } }
  func decide(_ problem: FileTransferProblem) -> FileTransferDecision {
    if isCancelled { return .cancel }
    let decision = onProblem?(problem) ?? .skip
    if decision == .cancel { cancel() }
    return decision
  }
  func report(_ source: URL, completed: Int64, total: Int64) {
    let now = Date()
    lock.lock()
    let deliver = source != lastSource || now.timeIntervalSince(lastProgress) >= 0.1 || completed >= total
    if deliver { lastProgress = now; lastSource = source }
    lock.unlock()
    if deliver { onProgress?(FileTransferProgress(source: source, completedBytes: completed, totalBytes: total)) }
  }
}

/// System copy preserves native streams/metadata and supplies progress without a second data pass.
/// ACL inheritance remains the destination filesystem's responsibility.
enum NativeTransferCopy {
  struct Failure: LocalizedError {
    let underlying: NSError
    let handled: Bool
    var errorDescription: String? { underlying.localizedDescription }
  }
  private final class State {
    let control: FileTransferControl?
    let source: URL
    let total: Int64
    var files: [String: Int64] = [:]
    var propertiesLost = false
    var completed: Int64 = 0
    var failureCode: Int32 = 0
    var failureHandled = false
    let destination: URL
    let moving: Bool
    init(_ control: FileTransferControl?, _ source: URL, _ destination: URL, _ total: Int64, _ moving: Bool) { self.control = control; self.source = source; self.destination = destination; self.total = total; self.moving = moving }
  }
  private static let callback: copyfile_callback_t = { what, stage, state, source, _, context in
    guard let context else { return COPYFILE_QUIT }
    let value = Unmanaged<State>.fromOpaque(context).takeUnretainedValue()
    if value.control?.isCancelled == true { return COPYFILE_QUIT }
    if stage == COPYFILE_ERR {
      value.failureCode = errno
      if what == COPYFILE_COPY_XATTR {
        var attribute: UnsafePointer<CChar>?
        if let state { _ = copyfile_state_get(state, UInt32(COPYFILE_STATE_XATTRNAME), &attribute) }
        let underlying = NSError(domain: NSPOSIXErrorDomain, code: Int(value.failureCode))
        let error = NSError(domain: NSPOSIXErrorDomain, code: underlying.code, userInfo: [NSLocalizedDescriptionKey: underlying.localizedDescription + (attribute.map { " (" + String(cString: $0) + ")" } ?? "")])
        let choice = value.control?.decide(FileTransferProblem(source: value.source, destination: value.destination, message: error.localizedDescription, propertyLoss: true, moving: value.moving)) ?? .skip
        value.failureHandled = value.control != nil && (choice == .skip || choice == .cancel)
        if choice == .retry { return COPYFILE_CONTINUE }
        if choice == .continueWithoutProperties { value.propertiesLost = true; return COPYFILE_SKIP }
      }
      return COPYFILE_QUIT
    }
    if what == COPYFILE_COPY_DATA, let state {
      var copied: off_t = 0
      if copyfile_state_get(state, UInt32(COPYFILE_STATE_COPIED), &copied) == 0 {
        let path = source.map { String(cString: $0) } ?? value.source.path
        value.completed += max(0, copied - (value.files[path] ?? 0)); value.files[path] = copied
        value.control?.report(value.source, completed: min(value.completed, value.total), total: value.total)
      }
    }
    return COPYFILE_CONTINUE
  }
  static func copy(_ source: URL, to destination: URL, total: Int64, control: FileTransferControl?, moving: Bool) throws -> Bool {
    try run(source, to: destination, total: total, control: control, moving: moving, descriptors: nil)
  }
  /// The caller exclusively creates and holds the destination; fcopyfile cannot replace a path.
  static func copyDescriptors(_ source: Int32, to destination: Int32, sourceURL: URL, destinationURL: URL, total: Int64, control: FileTransferControl?, moving: Bool, link: Bool) throws -> Bool {
    try run(sourceURL, to: destinationURL, total: total, control: control, moving: moving, descriptors: (source, destination, link))
  }
  private static func run(_ source: URL, to destination: URL, total: Int64, control: FileTransferControl?, moving: Bool, descriptors: (Int32, Int32, Bool)?) throws -> Bool {
    try control?.check()
    guard let state = copyfile_state_alloc() else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOMEM)) }
    defer { copyfile_state_free(state) }
    let value = State(control, source, destination, total, moving)
    let context = Unmanaged.passUnretained(value).toOpaque()
    let pointer = unsafeBitCast(callback, to: UnsafeRawPointer.self)
    guard copyfile_state_set(state, UInt32(COPYFILE_STATE_STATUS_CB), pointer) == 0,
          copyfile_state_set(state, UInt32(COPYFILE_STATE_STATUS_CTX), context) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    // No COPYFILE_MOVE: the transfer owns the separate, guarded source-cleanup step.
    let flags = copyfile_flags_t(COPYFILE_DATA | COPYFILE_STAT | COPYFILE_XATTR | COPYFILE_RECURSIVE | COPYFILE_EXCL | COPYFILE_NOFOLLOW | COPYFILE_CLONE)
    let result = withExtendedLifetime(value) {
      if let (from, to, link) = descriptors {
        return fcopyfile(from, to, state, copyfile_flags_t(link ? COPYFILE_XATTR | COPYFILE_NOFOLLOW : COPYFILE_DATA | COPYFILE_STAT | COPYFILE_XATTR))
      }
      return copyfile(source.path, destination.path, state, flags)
    }
    let failureCode = value.failureCode == 0 ? errno : value.failureCode
    try control?.check()
    guard result == 0 else { throw Failure(underlying: NSError(domain: NSPOSIXErrorDomain, code: Int(failureCode)), handled: value.failureHandled) }
    control?.report(source, completed: total, total: total)
    return value.propertiesLost
  }
}
