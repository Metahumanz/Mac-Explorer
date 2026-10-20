import Foundation

public struct SavedSMBConnection: Equatable, Sendable, Identifiable {
  public let id: UUID
  public let name: String
  public let address: String
  public init(id: UUID = UUID(), name: String, address: String) throws {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.count <= 120, !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw NativeNetwork.failure("请输入有效的连接名称（最多 120 个字符）。") }
    self.id = id; self.name = name; self.address = try Self.canonicalAddress(address)
  }
  public static func canonicalAddress(_ input: String) throws -> String {
    let url = try NativeNetwork.validate(input)
    var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    parts.host = parts.host?.lowercased()
    if parts.port == 445 { parts.port = nil }
    while parts.percentEncodedPath.hasSuffix("/") { parts.percentEncodedPath.removeLast() }
    return parts.url!.absoluteString
  }
}

/// Only validated display names and credential-free addresses are persisted; no mount paths or status.
public struct SavedSMBConnections {
  public static let changed = Notification.Name("NativeExplorerSavedSMBConnectionsChanged")
  public static let key = "savedSMBConnections"
  private let defaults: UserDefaults
  public init(defaults: UserDefaults) { self.defaults = defaults }
  public func list() -> [SavedSMBConnection] {
    var ids = Set<UUID>(), addresses = Set<String>()
    return (defaults.array(forKey: Self.key) ?? []).prefix(1000).compactMap { raw in
      guard let item = raw as? [String: String], let text = item["id"], let id = UUID(uuidString: text), let name = item["name"], let address = item["address"],
        let value = try? SavedSMBConnection(id: id, name: name, address: address), !ids.contains(id), !addresses.contains(value.address), ids.count < 100 else { return nil }
      ids.insert(id); addresses.insert(value.address); return value
    }
  }
  @discardableResult
  public func save(id: UUID? = nil, name: String, address: String) throws -> SavedSMBConnection {
    let value = try SavedSMBConnection(id: id ?? UUID(), name: name, address: address)
    var values = list()
    guard !values.contains(where: { $0.address == value.address && $0.id != id }) else { throw NativeNetwork.failure("该连接已在常用连接中。") }
    if let id {
      guard let index = values.firstIndex(where: { $0.id == id }) else { throw NativeNetwork.failure("连接已被移除，请刷新后重试。") }
      values[index] = value
    } else {
      guard values.count < 100 else { throw NativeNetwork.failure("最多保存 100 个常用连接。") }
      values.append(value)
    }
    write(values); return value
  }
  public func remove(_ id: UUID) { write(list().filter { $0.id != id }) }
  private func write(_ values: [SavedSMBConnection]) {
    defaults.set(values.map { ["id": $0.id.uuidString, "name": $0.name, "address": $0.address] }, forKey: Self.key)
    NotificationCenter.default.post(name: Self.changed, object: nil)
  }
}
