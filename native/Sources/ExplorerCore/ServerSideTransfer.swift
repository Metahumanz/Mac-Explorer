import Foundation

/// A per-operation data-only optimization. Metadata, publication and source deletion remain owned
/// by VerifiedTransfer. Returning false guarantees no remote data write is outstanding.
public protocol ServerSideCopyProvider: Sendable {
  func isCandidate(source: URL, destination: URL) -> Bool
  func copy(sourceDescriptor: Int32, destinationDescriptor: Int32, source: URL, destination: URL, control: FileTransferControl) throws -> Bool
}

public enum ServerSideCopyError: LocalizedError {
  case failed(Int32)
  case uncertain(Int32)
  public var isUncertain: Bool { if case .uncertain = self { return true }; return false }
  public var errorDescription: String? {
    switch self {
    case .failed(let code): return NL("服务端复制失败（错误码 {0}）。", String(code))
    case .uncertain(let code): return NL("服务端复制状态未确认，来源和目标均已保留（错误码 {0}）。", String(code))
    }
  }
}
