import AppKit
import ExplorerCore

private final class FixtureAirDropDiscovery: AirDropDiscovering {
  var onChange: (([String], AirDropDiscoveryError?) -> Void)?
  var starts = 0, stops = 0
  func start() { starts += 1; onChange?([], nil) }
  func stop() { stops += 1 }
  func emit(_ names: [String], error: AirDropDiscoveryError? = nil) { onChange?(names, error) }
}

@MainActor
enum NativeAirDropUIChecks {
  static func run() async throws -> [String] {
    var checks: [String] = []
    func check(_ condition: Bool, _ name: String) throws {
      guard condition else { throw NativeSmoke.Failure(description: name) }
      checks.append(name)
    }
    func views(_ root: NSView) -> [NSView] { root.isHidden ? [] : [root] + root.subviews.flatMap(views) }
    let fixture = FixtureAirDropDiscovery()
    let view = ExplorerSpecialView(frame: NSRect(x: 0, y: 0, width: 700, height: 520), airDrop: fixture)
    let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = view
    defer { window.contentView = nil; window.close() }
    func texts() -> [String] { views(view).compactMap { ($0 as? NSTextField)?.stringValue } }
    view.show("airdrop"); view.layoutSubtreeIfNeeded()
    try check(fixture.starts == 1 && texts().contains("附近设备"), "AirDrop page starts discovery inside ME")
    try check(texts().contains("正在查找附近设备…"), "AirDrop initially shows a concise scanning status")
    fixture.emit(["Fixture iPhone", "Fixture Mac"]); view.layoutSubtreeIfNeeded()
    try check(texts().contains("Fixture iPhone") && texts().contains("Fixture Mac") && texts().contains("2 台设备"), "Discovered peers appear in the ME page; names are fixture data")
    fixture.emit(["Fixture Mac"])
    try check(!texts().contains("Fixture iPhone") && texts().contains("Fixture Mac"), "Removed AirDrop peers disappear")
    let stale = fixture.onChange
    guard let refresh = views(view).compactMap({ $0 as? EDButton }).first(where: { $0.title == "重新查找" }) else { throw NativeSmoke.Failure(description: "AirDrop refresh button") }
    refresh.performClick(nil)
    try check(fixture.starts == 2, "AirDrop refresh restarts discovery")
    stale?(["Stale fixture"], nil)
    try check(!texts().contains("Stale fixture"), "Refreshed AirDrop page rejects old-session callbacks")
    fixture.emit([], error: .unavailable)
    try check(texts().contains("无法查找附近设备"), "Missing private discovery displays a concise fallback status")
    try check(views(view).compactMap { $0 as? EDButton }.contains { $0.title == "选择文件…" && $0.isEnabled }, "System AirDrop file selection remains available after discovery failure")
    view.show("computer")
    try check(fixture.onChange == nil && fixture.stops > 0, "Leaving AirDrop disconnects and stops discovery")
    fixture.emit(["Hidden fixture"])
    try check(!texts().contains("Hidden fixture") && !texts().contains("附近设备"), "AirDrop callbacks cannot populate another location")
    view.show("airdrop")
    try await Task.sleep(nanoseconds: 5_150_000_000)
    try check(texts().contains("未发现附近设备"), "Empty discovery settles without adding explanatory paragraphs")
    view.isHidden = true
    try check(fixture.onChange == nil, "Hiding the special page disconnects AirDrop callbacks")
    view.isHidden = false; view.show("airdrop")
    let stops = fixture.stops
    window.close()
    try check(fixture.onChange == nil && fixture.stops > stops, "Closing the window stops AirDrop discovery while its content is retained")
    return checks
  }
}
