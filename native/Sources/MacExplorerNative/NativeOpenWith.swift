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
    if let commonDefault, let index = apps.firstIndex(of: commonDefault) { apps.remove(at: index); apps.insert(commonDefault, at: 0) }
    return apps.map { app in
      let name = FileManager.default.displayName(atPath: app.path)
      return NativeOpenWithApplication(url: app, name: (name as NSString).pathExtension.lowercased() == "app" ? (name as NSString).deletingPathExtension : name, isDefault: app == commonDefault)
    }
  }
}
