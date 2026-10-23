import Foundation
import Darwin

/// Exact mount-source mapping. Display names, DNS aliases and different login identities never
/// establish eligibility. The native transport also compares mounted numeric session endpoints.
public struct SMBMountedLocation: Equatable, Sendable {
  public let root: URL
  public let host: String
  public let port: Int
  public let account: String
  public let share: String
  public let remotePath: String
  public var authority: String { (host.contains(":") ? "[\(host)]" : host) + ":\(port)" }
  public init?(root: URL, mountSource: String, filesystem: String, file: URL) {
    guard filesystem == "smbfs", root.isFileURL, file.isFileURL, root.path != "/",
      [nil, "", "localhost"].contains(root.host), [nil, "", "localhost"].contains(file.host),
      root.standardizedFileURL.path == root.path, file.standardizedFileURL.path == file.path,
      file.path == root.path || file.path.hasPrefix(root.path + "/"),
      mountSource.hasPrefix("//"), let parts = URLComponents(string: "smb:" + mountSource),
      let host = parts.host?.lowercased(), !host.isEmpty, parts.password == nil, parts.query == nil, parts.fragment == nil,
      parts.port.map({ (1...65535).contains($0) }) ?? true else { return nil }
    let encoded = parts.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
    guard encoded.first == "", encoded.count >= 2 else { return nil }
    let decoded = encoded.dropFirst().compactMap { String($0).removingPercentEncoding }
    guard decoded.count == encoded.count - 1, let share = decoded.first, Self.safe(share) else { return nil }
    let prefix = Array(decoded.dropFirst())
    let relative = file.path == root.path ? [] : String(file.path.dropFirst(root.path.count + 1)).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    // Subdirectory/DFS mounts require a different share-root binding; do not guess.
    guard prefix.isEmpty, relative.allSatisfy(Self.safe), !host.contains("%"), host != ".", host != "..",
      !(parts.user ?? "").unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
      !host.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
    self.root = root; self.host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")); port = parts.port ?? 445
    account = parts.user ?? ""; self.share = share; remotePath = (prefix + relative).joined(separator: "/")
  }
  private static func safe(_ component: String) -> Bool {
    !component.isEmpty && component != "." && component != ".." && !component.contains("/") && !component.contains("\\") && !component.contains(":") && !component.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
  }
  public func canTransfer(to other: Self) -> Bool {
    root != other.root && host == other.host && port == other.port && account.caseInsensitiveCompare(other.account) == .orderedSame
      && share.caseInsensitiveCompare(other.share) != .orderedSame
  }
  public static func read(descriptor: Int32, file: URL) -> Self? {
    var info = statfs(); guard fstatfs(descriptor, &info) == 0 else { return nil }
    func string<T>(_ tuple: inout T) -> String { withUnsafePointer(to: &tuple) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: MemoryLayout<T>.size) { String(cString: $0) } } }
    let filesystem = string(&info.f_fstypename), source = string(&info.f_mntfromname), mount = string(&info.f_mntonname)
    return Self(root: URL(fileURLWithPath: mount), mountSource: source, filesystem: filesystem, file: file)
  }
  public static func read(_ file: URL) -> Self? {
    let fd = open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { return nil }; defer { Darwin.close(fd) }
    return read(descriptor: fd, file: file)
  }
}
