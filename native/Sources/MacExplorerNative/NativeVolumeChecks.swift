import AppKit
import ExplorerCore

@MainActor
enum NativeVolumeChecks {
  private static func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
  private static func texts(_ view: NSView) -> [String] { descendants(view).compactMap { ($0 as? NSTextField)?.stringValue } }
  private static func until(_ condition: () -> Bool) async throws {
    let end = Date().addingTimeInterval(10)
    while !condition() {
      guard Date() < end else { throw NativeSmoke.Failure(description: "Volume UI check timed out") }
      try await Task.sleep(nanoseconds: 20_000_000)
    }
  }
  private static func capture(_ window: NSWindow, to url: URL) throws {
    guard let view = window.contentView else { throw NativeSmoke.Failure(description: "Missing volume window") }
    view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw NativeSmoke.Failure(description: "Cannot capture volume window") }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    guard let data = bitmap.representation(using: .png, properties: [:]) else { throw NativeSmoke.Failure(description: "Cannot encode volume window") }
    try data.write(to: url)
  }
  static func run(output: URL) async throws -> [String] {
    let path = URL(fileURLWithPath: "/Volumes/NativeVolumeFixture-" + UUID().uuidString)
    func volume(_ name: String, _ kind: NativeVolumeKind, _ total: Int64?, _ free: Int64?, unavailable: Bool = false) -> NativeVolume {
      NativeVolume(url: path.appendingPathComponent(name), name: name, total: total, free: free, kind: kind, canEject: kind != .unknown, metadataUnavailable: unavailable)
    }
    let known = volume("Network known", .network, 1000, 250)
    let partial = volume("Network partial", .network, 1000, nil)
    let offline = volume("Network offline", .network, nil, nil, unavailable: true)
    let unknown = volume("Unknown volume", .unknown, nil, nil)
    let zero = volume("Zero capacity", .local, 0, 0)
    let invalid = volume("Invalid capacity", .local, 10, 11)
    let external = volume("External volume with a long name 外置磁盘的长名称", .local, 500, 100)
    var snapshot = [known, partial, offline, unknown, zero, invalid, external], failRead = false
    let view = ExplorerSpecialView(volumeLoader: {
      if failRead { throw NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES)) }
      return snapshot
    }, discoveryEnabled: false)
    let previousAppearance = NSApp.appearance, previousKey = NSApp.keyWindow
    let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1000, height: 760), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = view; window.makeKeyAndOrderFront(nil)
    defer { window.close(); NSApp.appearance = previousAppearance; previousKey?.makeKeyAndOrderFront(nil) }
    var checks: [String] = []
    func check(_ condition: Bool, _ text: String) throws {
      guard condition else { throw NativeSmoke.Failure(description: text) }; checks.append(text); print("PASS volumes: " + text)
    }
    func cards() -> [DriveCard] { descendants(view).compactMap { $0 as? DriveCard } }
    func card(_ name: String) throws -> DriveCard {
      guard let result = cards().first(where: { $0.volume.name == name }) else { throw NativeSmoke.Failure(description: "Missing drive card: " + name) }; return result
    }
    view.show("computer")
    try await until { cards().count == snapshot.count }
    try check(texts(view).contains(NL("设备和驱动器（{0}）", snapshot.count)), "Computer heading counts every known and unknown volume")
    try check(try texts(card(known.name)).contains(NL("网络驱动器")) && texts(card(external.name)).contains(NL("本地磁盘")), "Network and external local cards have distinct type labels")
    try check(try texts(card(unknown.name)).contains(NL("类型未知")) && texts(card(unknown.name)).contains(NL("容量未知")), "Missing volume fields render as unknown instead of local or zero")
    try check(try texts(card(offline.name)).contains(NL("容量不可用")) && texts(card(offline.name)).contains(NL("网络驱动器")), "Offline metadata preserves known network type and an unavailable capacity")
    try check(try texts(card(partial.name)).contains(NL("{0} 可用，共 {1}", NL("未知"), ExplorerFormat.size(1000))), "Partial capacity retains the known total and labels free space unknown")
    try check(try texts(card(zero.name)).contains(NL("{0} 可用，共 {1}", ExplorerFormat.size(0), ExplorerFormat.size(0))), "Actual zero capacity is displayed as zero")
    try check(try texts(card(invalid.name)).contains(NL("容量不可用")) && card(invalid.name).volume.usedFraction == nil, "Contradictory capacities do not render a trustworthy occupied proportion")
    try check(try card(known.name).accessibilityLabel()?.contains(NL("网络驱动器")) == true && card(known.name).accessibilityLabel()?.contains(ExplorerFormat.size(250)) == true, "Drive accessibility includes type and free capacity")
    var navigation: URL?
    view.onNavigate = { navigation = $0 }
    _ = try card(known.name).accessibilityPerformPress()
    try check(navigation == known.url, "Drive card activation retains its exact navigation target without opening it in the test")
    for width in [1000.0, 480.0] {
      window.setContentSize(NSSize(width: width, height: 760)); view.needsLayout = true; view.layoutSubtreeIfNeeded()
      try check(cards().allSatisfy { $0.frame.minX >= 0 && $0.frame.maxX <= view.bounds.width && $0.bounds.width >= 200 }, "Drive cards fit the \(Int(width))-point viewport")
      try check(cards().flatMap(descendants).allSatisfy { $0.frame.width >= 0 }, "Long drive names keep nonnegative control widths")
      for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
        NSApp.appearance = NSAppearance(named: appearance)
        try capture(window, to: output.appendingPathComponent("native-volumes-\(Int(width))-\(name).png"))
      }
    }
    view.filter("Unknown")
    try check(cards().count == 1 && cards().first?.volume.kind == .unknown, "Computer search keeps unknown volumes accessible")
    view.filter(known.path)
    try check(cards().count == 1 && cards().first?.volume.url == known.url, "Drive search continues to match full paths")
    window.setContentSize(NSSize(width: 1000, height: 760)); NSApp.appearance = NSAppearance(named: .aqua)
    view.show("network")
    try await until { texts(view).contains(known.name) }
    try check(texts(view).contains(partial.name) && texts(view).contains(offline.name) && !texts(view).contains(unknown.name) && !texts(view).contains(external.name), "Network page shows confirmed network mounts including unavailable ones, excluding unknown and local")
    let opens = descendants(view).compactMap { $0 as? EDButton }.filter { $0.title == NL("打开") }
    try check(opens.count == 3, "Mounted network entries retain their Open controls")
    navigation = nil; opens.first?.onPress?()
    try check(navigation.map { [known.url, partial.url, offline.url].contains($0) } == true, "Mounted row activation preserves a fixture mount URL")
    try capture(window, to: output.appendingPathComponent("native-volumes-network.png"))
    failRead = true; view.show("computer")
    try await until { texts(view).contains(NL("无法读取已挂载的磁盘。")) }
    try check(cards().isEmpty && texts(view).contains(NL("设备和驱动器（{0}）", 0)), "Enumeration failure clears stale computer cards and reports an error")
    view.show("network")
    try await until { texts(view).contains(NL("无法读取已挂载的磁盘。")) }
    try check(texts(view).contains(NL("已连接的共享")) && !texts(view).contains(known.name), "Network discovery status does not erase a mount-enumeration failure")
    try capture(window, to: output.appendingPathComponent("native-volumes-unavailable.png"))
    failRead = false; snapshot = [known]
    guard let refresh = descendants(view).compactMap({ $0 as? EDButton }).first(where: { $0.title == NL("重新查找") }) else { throw NativeSmoke.Failure(description: "Missing volume refresh") }
    refresh.onPress?()
    try await until { texts(view).contains(known.name) && !texts(view).contains(NL("无法读取已挂载的磁盘。")) }
    try check(true, "Network refresh reloads mounts and clears recovered errors")

    // A slow previous read cannot replace a newer result from the same page's refresh.
    var calls = 0, pending: CheckedContinuation<[NativeVolume], Never>?
    let delayed = ExplorerSpecialView(volumeLoader: {
      calls += 1
      if calls == 1 { return await withCheckedContinuation { pending = $0 } }
      return [known]
    }, discoveryEnabled: false)
    window.contentView = delayed; delayed.show("network")
    defer { pending?.resume(returning: []); pending = nil }
    try await until { pending != nil }
    descendants(delayed).compactMap { $0 as? EDButton }.first { $0.title == NL("重新查找") }?.onPress?()
    try await until { texts(delayed).contains(known.name) }
    pending?.resume(returning: [offline]); pending = nil
    try await Task.sleep(nanoseconds: 100_000_000)
    try check(texts(delayed).contains(known.name) && !texts(delayed).contains(offline.name), "Late mount read cannot overwrite the newer refresh result")
    return checks
  }
}
