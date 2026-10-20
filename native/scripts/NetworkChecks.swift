import Foundation
import Darwin

@main
struct NetworkChecks {
  static func main() async throws {
    var checks = 0
    func check(_ condition: @autoclosure () throws -> Bool, _ name: String) throws { guard try condition() else { throw NSError(domain: "Check", code: 1, userInfo: [NSLocalizedDescriptionKey: name]) }; checks += 1 }
    func rejected(_ name: String, _ action: () throws -> Void) throws { do { try action() } catch { checks += 1; return }; throw NSError(domain: "Check", code: 1, userInfo: [NSLocalizedDescriptionKey: "Accepted " + name]) }
    for (input, expected) in [
      (" smb://nas.local/团队 文件 ", "smb://nas.local/%E5%9B%A2%E9%98%9F%20%E6%96%87%E4%BB%B6"),
      ("smb://192.168.1.2", "smb://192.168.1.2"),
      ("smb://[::1]:1445/share", "smb://[::1]:1445/share"),
      ("SMB://nas.local/share", "smb://nas.local/share"),
      ("smb://nas/share/%23tag%3F.txt", "smb://nas/share/%23tag%3F.txt"),
    ] { try check(NativeNetwork.validate(input).absoluteString == expected, "Preserve SMB authority and path") }
    for input in ["", "smb://", "smb:server/share", "file:///tmp", "https://nas/share", "smb://user:secret@nas/share", "smb://user@nas/share", "smb://@nas/share", "smb://nas/share?option=1", "smb://nas/share?", "smb://nas/share#fragment", "smb://nas/share#", "smb://nas/\0share", "smb://nas/\nshare", "smb://nas\\share", "smb://nas:99999/share", "smb://nas:0/share", "smb://nas:-1/share", "smb://nas:abc/share", "smb://nas:/share", "smb://[broken]/share", "smb://nas%40evil/share", "smb://nas%2Fevil/share", "smb://nas/%5Cshare", "smb://nas/%00share", "smb://nas/%0Ashare", "smb://" + String(repeating: "x", count: 2048)] {
      try rejected("invalid SMB address") { _ = try NativeNetwork.validate(input) }
    }
    let fm = FileManager.default, fixture = fm.temporaryDirectory.appendingPathComponent("NativeNetworkChecks-" + UUID().uuidString)
    try fm.createDirectory(at: fixture, withIntermediateDirectories: true); defer { try? fm.removeItem(at: fixture) }
    try check(NativeNetwork.mountedDirectory([fixture.path]).path == fixture.path, "Return actual mounted directory")
    try rejected("relative mount result") { _ = try NativeNetwork.mountedDirectory(["relative"]) }
    try rejected("missing mount result") { _ = try NativeNetwork.mountedDirectory([fixture.appendingPathComponent("missing").path]) }
    try rejected("empty mount result") { _ = try NativeNetwork.mountedDirectory([]) }
    let root = NativeVolume(url: URL(fileURLWithPath: "/"), name: "root", total: 10, free: 5, kind: .local, canEject: true)
    let external = NativeVolume(url: URL(fileURLWithPath: "/Volumes/Fixture"), name: "Fixture", total: 10, free: 5, kind: .local, canEject: true)
    let network = NativeVolume(url: URL(fileURLWithPath: "/Volumes/Network"), name: "Network", total: 10, free: 5, kind: .network, canEject: true)
    try check(!root.canEject && root.kind == .local && network.isNetwork, "Root protected, local/network types retained")
    try check(NativeVolumes.ejectable(external.url, among: [root, external, network]) == external, "Validate exact ejectable mount")
    for url in [root.url, external.url.appendingPathComponent("file"), URL(fileURLWithPath: "/Volumes/Missing"), URL(string: "smb://server/share")!, URL(string: "file://foreign/Volumes/Fixture")!, URL(string: "file:///Volumes/Fixture?flag=1")!] { try rejected("invalid eject target") { _ = try NativeVolumes.ejectable(url, among: [root, external]) } }
    let unknown = NativeVolume(url: external.url, name: "Unknown", total: nil, free: nil, kind: .unknown, canEject: false)
    try check(!unknown.isNetwork && unknown.capacityState == .unknown && unknown.usedFraction == nil, "Unknown type and capacities stay unknown")
    try check(network.usedFraction == 0.5, "Known capacity has a bounded occupied proportion")
    for (total, free, state) in [(Int64?(0), Int64?(0), NativeVolumeCapacityState.known), (nil, 2, .partial), (10, nil, .partial), (-1, 2, .invalid), (10, -1, .invalid), (10, 11, .invalid), (0, 1, .invalid), (nil, nil, .unknown)] {
      let volume = NativeVolume(url: external.url, name: "Capacity", total: total, free: free, kind: .local, canEject: true)
      try check(volume.capacityState == state && volume.usedFraction == nil, "Missing, zero and invalid capacities do not claim an occupied proportion")
    }
    for free in [Int64(0), Int64.max] {
      let volume = NativeVolume(url: external.url, name: "Extreme", total: Int64.max, free: free, kind: .local, canEject: false)
      try check(volume.usedFraction == (free == 0 ? 1 : 0), "Large capacities do not overflow")
    }
    let unavailable = NativeVolume(url: external.url, name: "Offline", total: 10, free: 5, kind: .network, canEject: true, metadataUnavailable: true)
    try check(unavailable.capacityState == .unavailable && unavailable.total == nil && unavailable.free == nil, "Read failure does not reuse stale capacities")
    let mounts = [URL(fileURLWithPath: "/Volumes/SMB"), root.url, URL(fileURLWithPath: "/Volumes/Unknown"), URL(fileURLWithPath: "/Volumes/Denied"), URL(fileURLWithPath: "/Volumes/Missing"), external.url, external.url, fixture]
    let reader = NativeVolumeReader(mountedURLs: { mounts }, mountKinds: { ["/": .local, "/Volumes/SMB": .network, "/Volumes/Denied": .network] }, attributes: { url in
      if url.lastPathComponent == "Denied" { throw NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES)) }
      if url.lastPathComponent == "Missing" { throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOENT)) }
      return NativeVolumeAttributes(name: url.lastPathComponent, total: url.lastPathComponent == "SMB" ? 10 : nil, free: nil, local: url == external.url ? true : url.lastPathComponent == "SMB" ? true : nil, ejectable: url == root.url)
    })
    let modeled = try NativeVolumes.list(using: reader)
    try check(modeled.count == 6 && modeled.first?.path == "/" && modeled.filter { $0.path == external.path }.count == 1, "Volume list keeps root first, filters non-volume paths and deduplicates")
    try check(modeled.first { $0.path == "/Volumes/SMB" }?.kind == .network, "Kernel mount classification overrides contradictory cached URL flags")
    try check(modeled.first { $0.path == "/Volumes/SMB" }?.capacityState == .partial, "Partial metadata retains the known capacity")
    try check(modeled.first { $0.path == external.path }?.kind == .local, "URL local flag remains a fallback when the mount snapshot lacks a path")
    try check(modeled.first { $0.path == "/Volumes/Unknown" }?.kind == .unknown, "No mount evidence and no local flag do not imply local")
    try check(modeled.first { $0.path == "/Volumes/Denied" }?.kind == .network && modeled.first { $0.path == "/Volumes/Denied" }?.capacityState == .unavailable, "Per-volume permission error keeps the known network mount visible")
    try check(modeled.first { $0.path == "/Volumes/Missing" }?.kind == .unknown && modeled.first { $0.path == "/Volumes/Missing" }?.capacityState == .unavailable, "Disconnected mount remains an unavailable entry for this snapshot")
    try check(modeled.first?.canEject == false, "Root remains protected even when resource flags claim ejectable")
    try rejected("volume enumeration failure") { _ = try NativeVolumes.list(using: NativeVolumeReader(mountedURLs: { nil }, mountKinds: { [:] }, attributes: { _ in fatalError("No attributes after list failure") })) }
    try check(try NativeVolumes.list(using: NativeVolumeReader(mountedURLs: { [] }, mountKinds: { [:] }, attributes: { _ in fatalError("No empty attributes") })).isEmpty, "An empty snapshot is distinct from enumeration failure")
    let snapshot = try NativeVolumes.list()
    try check(snapshot.contains(where: { $0.path == "/" && !$0.canEject }), "Read-only real root volume metadata")
    try check(snapshot.allSatisfy { ($0.total ?? 0) >= 0 && ($0.free ?? 0) >= 0 }, "Nonnegative real capacity metadata")
    let suite = "local.macexplorer.smb-store-checks." + UUID().uuidString, preferences = UserDefaults(suiteName: suite)!
    defer { preferences.removePersistentDomain(forName: suite) }
    let store = SavedSMBConnections(defaults: preferences)
    try check(store.list().isEmpty && preferences.object(forKey: SavedSMBConnections.key) == nil, "Empty favorites do not write preferences at startup")
    let saved = try store.save(name: "  团队 NAS  ", address: " SMB://NAS.LOCAL:445/团队 文件/ ")
    try check(saved.name == "团队 NAS" && saved.address == "smb://nas.local/%E5%9B%A2%E9%98%9F%20%E6%96%87%E4%BB%B6", "Saved addresses normalize host, default port, trailing slash and Unicode")
    try check(SavedSMBConnections(defaults: UserDefaults(suiteName: suite)!).list() == [saved], "A fresh store restores saved connections")
    let prior = preferences.array(forKey: SavedSMBConnections.key) as? [[String: String]]
    for address in ["smb://user:secret@nas/share", "smb://user@nas/share", "https://nas/share", "smb://nas/share?password=x", "smb://nas/%00share"] {
      try rejected("unsafe favorite") { _ = try store.save(name: "Unsafe", address: address) }
      try check(preferences.array(forKey: SavedSMBConnections.key) as? [[String: String]] == prior, "Rejected address leaves stored data untouched")
    }
    for name in ["", "\n", "a\nb", String(repeating: "a", count: 121)] { try rejected("invalid favorite name") { _ = try store.save(name: name, address: "smb://nas/share") } }
    try rejected("duplicate canonical favorite") { _ = try store.save(name: "Duplicate", address: saved.address + "/") }
    let other = try SavedSMBConnections(defaults: preferences).save(name: "Other", address: "smb://nas/Case")
    let renamed = try store.save(id: saved.id, name: "Renamed", address: saved.address)
    try check(store.list() == [renamed, other], "Editing fresh preferences preserves another window's newer record")
    try rejected("editing a removed connection") { _ = try store.save(id: UUID(), name: "Missing", address: "smb://nas/missing") }
    try check(try SavedSMBConnection.canonicalAddress("smb://NAS:1445/Case") == "smb://nas:1445/Case", "Nondefault port and path case remain distinct")
    try check(Set((preferences.array(forKey: SavedSMBConnections.key) as! [[String: String]])[0].keys) == ["id", "name", "address"], "Only ID, display name and address are persisted")
    store.remove(saved.id)
    try check(store.list() == [other], "Remove affects only the selected connection")
    preferences.set(["malformed", ["id": other.id.uuidString, "name": other.name, "address": other.address], ["id": UUID().uuidString, "name": "Duplicate", "address": other.address], ["id": UUID().uuidString, "name": "Unsafe", "address": "smb://user:secret@nas/share"]] as [Any], forKey: SavedSMBConnections.key)
    try check(store.list() == [other], "Malformed, duplicate and credential-bearing persisted records are ignored without discarding valid records")
    preferences.removeObject(forKey: SavedSMBConnections.key)
    for index in 0..<100 { _ = try store.save(name: "Connection \(index)", address: "smb://fixture/share\(index)") }
    try rejected("favorite limit") { _ = try store.save(name: "Extra", address: "smb://fixture/extra") }
    try check(store.list().count == 100, "Favorite storage remains bounded")
    let address = try NativeNetwork.validate("smb://fixture/share"), token = UnsafeMutableRawPointer(bitPattern: 1)!
    let succeeded = NativeMountAPI(start: { _, queue, report in queue.asyncAfter(deadline: .now() + 0.01) { report(0, [fixture.path]) }; return (0, token) }, cancel: { _ in fatalError("Unexpected cancellation") })
    let mounted = try await NativeMountRequest(api: succeeded).run(address, timeout: 1)
    try check(mounted == [fixture.path], "Async NetFS success")
    let userCancelled = NativeMountAPI(start: { _, queue, report in queue.async { report(-128, nil) }; return (0, token) }, cancel: { _ in 0 })
    let cancelledResult = try await NativeMountRequest(api: userCancelled).run(address, timeout: 1)
    try check(cancelledResult == nil, "System authentication cancel is not an error")
    let startCancelled = NativeMountAPI(start: { _, _, _ in (-128, nil) }, cancel: { _ in 0 })
    let immediateCancelled = try await NativeMountRequest(api: startCancelled).run(address)
    try check(immediateCancelled == nil, "Immediate system cancellation")
    let denied = NativeMountAPI(start: { _, _, _ in (EACCES, nil) }, cancel: { _ in 0 })
    do { _ = try await NativeMountRequest(api: denied).run(address); fatalError("Accepted permission error") } catch { checks += 1 }
    let pending = NativeMountAPI(start: { _, _, _ in (0, token) }, cancel: { _ in 0 })
    do { _ = try await NativeMountRequest(api: pending).run(address, timeout: 0.01); fatalError("No timeout") } catch { checks += 1 }
    let cancelledTask = Task { try await NativeMountRequest(api: pending).run(address, timeout: 1) }
    try await Task.sleep(nanoseconds: 20_000_000); cancelledTask.cancel()
    let confirmed = try await cancelledTask.value
    try check(confirmed == nil, "Confirmed NetFS request cancellation")
    let cancelRejected = NativeMountAPI(start: { _, queue, report in queue.asyncAfter(deadline: .now() + 0.05) { report(0, [fixture.path]) }; return (0, token) }, cancel: { _ in EBUSY })
    let unfinished = Task { try await NativeMountRequest(api: cancelRejected).run(address, timeout: 1) }
    try await Task.sleep(nanoseconds: 10_000_000); unfinished.cancel()
    let actual = try await unfinished.value
    try check(actual == [fixture.path], "Failed cancellation waits for actual outcome")
    let service = NativeNetwork()
    let first = Task { try await service.connect("smb://fixture/share") { _ in try await Task.sleep(nanoseconds: 80_000_000); return [fixture.path] } }
    try await Task.sleep(nanoseconds: 10_000_000)
    do { _ = try await service.connect("smb://fixture/share") { _ in fatalError("Duplicate network operation started") }; fatalError("Accepted duplicate connection") } catch { checks += 1 }
    let finalDirectory = try await first.value
    try check(finalDirectory?.path == fixture.path, "Connection resolves mount instead of guessing share path")
    let serviceIdle = await service.isConnecting
    try check(!serviceIdle, "Connection guard released after completion")
    let noMount = try await service.connect("smb://fixture/share") { _ in nil }
    try check(noMount == nil, "Actor cancellation outcome")
    print("Native network/volume checks passed: \(checks); no real SMB connection or eject operation.")
  }
}
