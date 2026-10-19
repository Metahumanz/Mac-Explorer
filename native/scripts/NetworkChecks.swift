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
    let root = NativeVolume(url: URL(fileURLWithPath: "/"), name: "root", total: 10, free: 5, local: true, canEject: true)
    let external = NativeVolume(url: URL(fileURLWithPath: "/Volumes/Fixture"), name: "Fixture", total: 10, free: 5, local: true, canEject: true)
    let network = NativeVolume(url: URL(fileURLWithPath: "/Volumes/Network"), name: "Network", total: 10, free: 5, local: false, canEject: true)
    try check(!root.canEject && root.local && network.isNetwork, "Root protected, local/network types retained")
    try check(NativeVolumes.ejectable(external.url, among: [root, external, network]) == external, "Validate exact ejectable mount")
    for url in [root.url, external.url.appendingPathComponent("file"), URL(fileURLWithPath: "/Volumes/Missing"), URL(string: "smb://server/share")!, URL(string: "file://foreign/Volumes/Fixture")!, URL(string: "file:///Volumes/Fixture?flag=1")!] { try rejected("invalid eject target") { _ = try NativeVolumes.ejectable(url, among: [root, external]) } }
    let snapshot = try NativeVolumes.list()
    try check(snapshot.contains(where: { $0.path == "/" && !$0.canEject }), "Read-only real root volume metadata")
    try check(snapshot.allSatisfy { $0.total >= 0 && $0.free >= 0 }, "Nonnegative real capacity metadata")
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
