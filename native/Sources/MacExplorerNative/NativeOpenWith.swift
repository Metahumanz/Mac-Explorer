import AppKit

struct NativeOpenWithApplication: Sendable {
  let url: URL
  let name: String
  let isDefault: Bool
}
enum NativeOpenWith {
  static func applications(_ urls: [URL]) -> [NativeOpenWithApplication] {
    guard let first = urls.first, urls.count <= 10_000 else { return [] }
    let workspace = NSWorkspace.shared
    var apps = workspace.urlsForApplications(toOpen: first)
    let originalDefault = workspace.urlForApplication(toOpen: first)
    var commonDefault = originalDefault
    for url in urls.dropFirst() {
      if Task.isCancelled { return [] }
      let available = Set(workspace.urlsForApplications(toOpen: url)); apps.removeAll { !available.contains($0) }
      if workspace.urlForApplication(toOpen: url) != originalDefault { commonDefault = nil }
    }
    return uniqueApplications(apps, defaultApplication: commonDefault)
  }

  static func uniqueApplications(_ urls: [URL], defaultApplication: URL?) -> [NativeOpenWithApplication] {
    let defaultURL = defaultApplication?.resolvingSymlinksInPath()
    let ownIDs = Set(["local.macexplorer.desktop", "local.macexplorer.native-prototype"])
    func priority(_ url: URL) -> Int {
      if url == defaultURL { return 0 }
      if url.path.hasPrefix("/Applications/") || url.path.hasPrefix("/System/Applications/") { return 1 }
      if url.path.hasPrefix(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path + "/") { return 2 }
      return 3
    }
    var seen = Set<String>()
    let apps = urls.map { $0.resolvingSymlinksInPath() }.sorted { priority($0) < priority($1) }.filter { url in
      guard FileManager.default.fileExists(atPath: url.path) else { return false }
      let id = Bundle(url: url)?.bundleIdentifier
      guard id != "local.macexplorer.native-validation" else { return false }
      let key = id.map { ownIDs.contains($0) ? "local.macexplorer" : $0 } ?? url.path
      return seen.insert(key).inserted
    }
    return apps.map { app in
      let name = FileManager.default.displayName(atPath: app.path)
      return NativeOpenWithApplication(url: app, name: (name as NSString).pathExtension.lowercased() == "app" ? (name as NSString).deletingPathExtension : name, isDefault: app == defaultURL)
    }
  }
}
