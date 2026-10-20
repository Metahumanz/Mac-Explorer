import Foundation

/// The side-by-side Fork has its own data and is not an upstream update target.
enum NativeAppProfile {
  static var isFork: Bool { Bundle.main.object(forInfoDictionaryKey: "MacExplorerBuildProfile") as? String == "fork" }
  static var supportDirectory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent(isFork ? "Mac Explorer Fork" : "Mac Explorer Native")
  }
}
