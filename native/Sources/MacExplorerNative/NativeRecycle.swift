import AppKit
import ExplorerCore

@MainActor
enum NativeRecycle {
  static func recycle(_ source: URL, cloudRoot: URL?, window: NSWindow) async throws -> URL {
    try FileActions.validateModificationSource(source)
    do { return try await perform(source) }
    catch {
      let failure = error as NSError
      let denied = failure.domain == NSCocoaErrorDomain && [NSFileReadNoPermissionError, NSFileWriteNoPermissionError].contains(failure.code) || failure.domain == NSPOSIXErrorDomain && [Int(EACCES), Int(EPERM)].contains(failure.code) || failure.domain == NSOSStatusErrorDomain && [-54, -5000].contains(failure.code)
      guard denied, let cloudRoot, source.path.hasPrefix(cloudRoot.path + "/") else { throw error }
      let selected: URL? = await withCheckedContinuation { continuation in
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.directoryURL = cloudRoot; panel.title = NL("允许访问 iCloud Drive"); panel.prompt = NL("允许访问")
        panel.beginSheetModal(for: window) { continuation.resume(returning: $0 == .OK ? panel.url : nil) }
      }
      guard let selected else { throw CocoaError(.userCancelled) }
      guard (selected.path == cloudRoot.path || selected.path.hasPrefix(cloudRoot.path + "/")), source.path.hasPrefix(selected.path + "/") else { throw NSError(domain: "NativeRecycle", code: 1, userInfo: [NSLocalizedDescriptionKey: NL("请选择包含该项目的 iCloud Drive 文件夹。")]) }
      return try await perform(source)
    }
  }
  private static func perform(_ source: URL) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      NSWorkspace.shared.recycle([source]) { destinations, error in
        if let destination = destinations.first(where: { $0.key.path == source.path })?.value { continuation.resume(returning: destination) }
        else { continuation.resume(throwing: error ?? CocoaError(.fileWriteUnknown)) }
      }
    }
  }
}
