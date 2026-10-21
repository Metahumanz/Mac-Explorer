import AppKit
import ExplorerCore
import UniformTypeIdentifiers

@MainActor
enum NativeTerminal {
  static let preferenceKey = "terminalApplication"
  static let applications = [("Terminal", "com.apple.Terminal"), ("Warp", "dev.warp.Warp-Stable"), ("iTerm2", "com.googlecode.iterm2"), ("Ghostty", "com.mitchellh.ghostty")]

  static func options(selected: String, lookup: (String) -> URL? = { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }) -> [(String, String)] {
    var values = [(NL("自动选择"), "")]
    for (name, identifier) in applications {
      if lookup(identifier) != nil { values.append((name, identifier)) }
      else if selected == identifier { values.append((NL("{0}（未安装）", name), identifier)) }
    }
    if !values.contains(where: { $0.1 == selected }) { values.append((NL("所选终端不可用"), selected)) }
    return values
  }

  static func request(directory: URL, selected: String, lookup: (String) -> URL? = { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }) throws -> (directory: URL, application: URL) {
    var isDirectory: ObjCBool = false
    guard directory.isFileURL, FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else {
      throw NSError(domain: "NativeTerminal", code: 1, userInfo: [NSLocalizedDescriptionKey: NL("请选择文件夹打开终端。")])
    }
    let application: URL?
    if selected.isEmpty { application = NSWorkspace.shared.urlForApplication(toOpen: UTType.unixExecutable) }
    else {
      guard applications.contains(where: { $0.1 == selected }), let installed = lookup(selected) else {
        throw NSError(domain: "NativeTerminal", code: 2, userInfo: [NSLocalizedDescriptionKey: NL("所选终端未安装，请在设置中重新选择。")])
      }
      application = installed
    }
    guard let application else { throw NSError(domain: "NativeTerminal", code: 3, userInfo: [NSLocalizedDescriptionKey: NL("没有可用的终端应用")]) }
    return (directory, application)
  }
}
