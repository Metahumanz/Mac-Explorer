import Foundation
import Darwin

/// Immutable confirmation metadata, never file contents. Paths are relative to the resolved parent.
public struct NetworkDeletionEntry: Sendable {
  public let path: String
  public let inode: UInt64
  public let type: UInt32
  public let size: Int64
  public let birthSeconds: Int64, birthNanos: Int64
  public let modifiedSeconds: Int64, modifiedNanos: Int64
  init(path: String, stamp: TransferStamp) {
    self.path = path; inode = stamp.inode; type = UInt32(stamp.type); size = stamp.size
    birthSeconds = Int64(stamp.birth.seconds); birthNanos = Int64(stamp.birth.nanos)
    modifiedSeconds = Int64(stamp.modified.seconds); modifiedNanos = Int64(stamp.modified.nanos)
  }
}

public protocol NetworkDeletionHandleProvider: Sendable {
  /// All confirmed objects must be bound before mutation; failure must release non-deleting handles.
  func prepare(source: URL, parentDescriptor: Int32, entries: [NetworkDeletionEntry]) throws -> NetworkDeletionHandles
}
public protocol NetworkDeletionHandles: AnyObject {
  /// Uses the original open handle. Never reopens a path, reconnects or falls back to unlink.
  func remove(path: String) throws
  /// Releases remaining handles without marking any additional object for deletion.
  func finish()
}
public struct NetworkDeletionHandleFailure: Error, LocalizedError {
  public let code: Int32
  public let uncertain: Bool
  public init(code: Int32, uncertain: Bool = false) { self.code = code; self.uncertain = uncertain }
  public var errorDescription: String? {
    uncertain ? NL("删除结果尚未确认，请刷新并检查来源。已停止后续删除。（错误码 {0}）", String(code))
      : NL("无法通过 SMB 文件句柄安全删除，已停止。（错误码 {0}）", String(code))
  }
}
