import AppKit
import ExplorerCore

final class NativeIconService {
  private var process: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var buffer = Data()
  private var requests: [Int: (NSImage?) -> Void] = [:]
  private var nextID = 0

  func request(path: String, pixels: Int, completion: @escaping (NSImage?) -> Void) {
    var requestID: Int?
    do {
      if process == nil { try start() }
      nextID += 1; let id = nextID; requestID = id; requests[id] = completion
      var data = try JSONSerialization.data(withJSONObject: ["id": id, "path": path, "pixels": pixels]); data.append(10)
      try input?.write(contentsOf: data)
      DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.requests.removeValue(forKey: id)?(nil) }
    } catch {
      if let requestID { requests.removeValue(forKey: requestID) }
      completion(nil)
    }
  }
  private func start() throws {
    guard let executable = Bundle.main.url(forResource: "file-icon", withExtension: nil) else { throw CocoaError(.fileNoSuchFile) }
    let worker = Process(), stdin = Pipe(), stdout = Pipe()
    worker.executableURL = executable; worker.standardInput = stdin; worker.standardOutput = stdout; worker.standardError = FileHandle.nullDevice
    input = stdin.fileHandleForWriting; output = stdout.fileHandleForReading
    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      DispatchQueue.main.async { [weak self] in self?.receive(data) }
    }
    worker.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.stop() } }
    try worker.run(); process = worker
  }
  private func receive(_ data: Data) {
    guard !data.isEmpty else { return }; buffer.append(data)
    while let end = buffer.firstIndex(of: 10) {
      let line = buffer[..<end]; buffer.removeSubrange(...end)
      guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let id = object["id"] as? Int else { continue }
      var image: NSImage?
      if let text = object["data"] as? String, let comma = text.firstIndex(of: ","), let png = Data(base64Encoded: String(text[text.index(after: comma)...])) { image = NSImage(data: png) }
      requests.removeValue(forKey: id)?(image)
    }
  }
  private func stop() {
    output?.readabilityHandler = nil; output = nil; input = nil; process = nil; buffer.removeAll()
    let callbacks = requests.values; requests.removeAll(); callbacks.forEach { $0(nil) }
  }
  deinit { output?.readabilityHandler = nil; try? input?.close(); process?.terminate() }
}
