import Foundation
import Darwin

public struct NativeCommandResult: Sendable {
  public let output: Data
  public let error: Data
  public let status: Int32
  public var text: String { String(decoding: output, as: UTF8.self) }
  public var errorText: String { String(decoding: error, as: UTF8.self) }
}
public struct NativeCommandError: LocalizedError, Sendable {
  public let result: NativeCommandResult
  public var errorDescription: String? { result.errorText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? NL("操作失败（{0}）", result.status) : result.errorText.trimmingCharacters(in: .whitespacesAndNewlines) }
}
private final class CommandCapture: @unchecked Sendable {
  private let lock = NSLock()
  private var buffer = Data()
  private var overflow = false
  func collect(_ pipe: Pipe, limit: Int, process: Process) {
    while true {
      let chunk = pipe.fileHandleForReading.readData(ofLength: 65536)
      if chunk.isEmpty { break }
      lock.lock()
      if buffer.count + chunk.count > limit { overflow = true; lock.unlock(); if process.isRunning { process.terminate() }; continue }
      buffer.append(chunk); lock.unlock()
    }
    try? pipe.fileHandleForReading.close()
  }
  var value: Data { lock.lock(); defer { lock.unlock() }; return buffer }
  var exceeded: Bool { lock.lock(); defer { lock.unlock() }; return overflow }
}
public enum NativeCommand {
  public static func run(executable: String, arguments: [String], directory: URL? = nil, environment: [String: String] = [:], timeout: TimeInterval = 30, limit: Int = 8 * 1024 * 1024, onStart: ((Process) -> Void)? = nil) throws -> NativeCommandResult {
    guard executable.hasPrefix("/"), !executable.contains("\0"), arguments.allSatisfy({ !$0.contains("\0") }), limit > 0, timeout > 0 else { throw CocoaError(.fileReadInvalidFileName) }
    try Task.checkCancellation()
    let process = Process(), output = Pipe(), errors = Pipe(), out = CommandCapture(), err = CommandCapture()
    process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments; process.currentDirectoryURL = directory
    process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, next in next }
    process.standardOutput = output; process.standardError = errors; process.standardInput = FileHandle.nullDevice
    try process.run()
    onStart?(process)
    let group = DispatchGroup()
    group.enter(); DispatchQueue.global(qos: .utility).async { out.collect(output, limit: limit, process: process); group.leave() }
    group.enter(); DispatchQueue.global(qos: .utility).async { err.collect(errors, limit: limit, process: process); group.leave() }
    let deadline = Date().addingTimeInterval(timeout)
    var terminated: Date?, cancelled = false, timedOut = false
    while process.isRunning {
      if Task.isCancelled || Date() >= deadline || out.exceeded || err.exceeded {
        cancelled = Task.isCancelled; timedOut = Date() >= deadline
        if terminated == nil { process.terminate(); terminated = Date() }
        else if Date().timeIntervalSince(terminated!) > 1 { kill(process.processIdentifier, SIGKILL) }
      }
      Thread.sleep(forTimeInterval: 0.01)
    }
    process.waitUntilExit()
    // Children must not retain our pipe indefinitely after the parent exits.
    if group.wait(timeout: .now() + 2) == .timedOut { try? output.fileHandleForReading.close(); try? errors.fileHandleForReading.close(); throw CocoaError(.fileReadUnknown) }
    if cancelled { throw CancellationError() }
    if timedOut { throw NSError(domain: "NativeCommand", code: 1, userInfo: [NSLocalizedDescriptionKey: NL("操作超时。")] ) }
    if out.exceeded || err.exceeded { throw NSError(domain: "NativeCommand", code: 2, userInfo: [NSLocalizedDescriptionKey: NL("操作返回的数据超过限制。")] ) }
    let result = NativeCommandResult(output: out.value, error: err.value, status: process.terminationStatus)
    if result.status != 0 { throw NativeCommandError(result: result) }
    return result
  }
}
