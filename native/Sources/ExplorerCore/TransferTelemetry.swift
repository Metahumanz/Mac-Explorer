import Foundation

public enum FileTransferPhase: String, Sendable {
  case preparing, connecting, copying, properties, verifying, publishing, removingSource, finishing
}

public struct FileTransferTiming: Sendable {
  public let stage: String
  public let seconds: TimeInterval
  public let depth: Int
  public let succeeded: Bool
  public let metrics: [String: Double]
}

/// A bounded window over acknowledged logical bytes. It never reads file contents.
struct TransferRateEstimator {
  private var source: URL?
  private var mode: FileTransferMode?
  private var samples: [(time: TimeInterval, bytes: Int64)] = []
  private var rate: Double?
  mutating func sample(source: URL, mode: FileTransferMode, completed: Int64, at time: TimeInterval) -> Double? {
    let bytes = max(0, completed)
    if self.source != source || self.mode != mode || samples.last.map({ time < $0.time || bytes < $0.bytes }) == true {
      self.source = source; self.mode = mode; samples = []; rate = nil
    }
    if samples.last?.bytes == bytes {
      if bytes == 0 { samples = [(time, 0)] }
      return rate
    }
    samples.append((time, bytes))
    while samples.count > 2 && samples[1].time < time - 2 { samples.removeFirst() }
    if samples.count > 128 { samples.removeFirst(samples.count - 128) }
    guard let first = samples.first, time > first.time, bytes > first.bytes else { return rate }
    let value = Double(bytes - first.bytes) / (time - first.time)
    rate = value.isFinite && value > 0 ? value : nil
    return rate
  }
}
