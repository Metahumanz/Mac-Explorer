import AppKit
import ExplorerCore

@MainActor
enum NativeShortcutChecks {
  static func run() throws -> [String] {
    var checks: [String] = []
    func check(_ condition: Bool, _ message: String) throws {
      guard condition else { throw NSError(domain: "NativeShortcutChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }; checks.append(message)
    }
    let recorder = EDShortcutRecorder(value: "")
    var recorded: String?, error: String?
    recorder.onRecord = { recorded = $0; return true }; recorder.onError = { error = $0 }
    func press(_ code: UInt16, _ characters: String, _ flags: NSEvent.ModifierFlags = []) -> ShortcutFixtureEvent {
      let event = ShortcutFixtureEvent(); event.code = code; event.text = characters; event.flags = flags
      recorded = nil; error = nil; recorder.keyDown(with: event); return event
    }
    let cyrillic = press(8, "с", .command)
    try check(recorded == "Command+C" && ExplorerShortcuts.key(cyrillic) == recorded && ExplorerShortcuts.match(cyrillic, overrides: [:]) == "copy", "Recorder and executor use physical letter keys across keyboard layouts")
    let f13 = press(105, String(UnicodeScalar(NSF13FunctionKey)!), .control)
    try check(recorded == "Control+F13" && ExplorerShortcuts.match(f13, overrides: ["copy": recorded!]) == "copy", "Recorded high function keys execute through the same mapping")
    let plus = press(24, "+", [.command, .shift])
    try check(recorded == "Command+Plus" && ExplorerShortcuts.key(plus) == recorded && ExplorerShortcuts.normalize("Command+Shift+=") == recorded, "Shift+equal uses the same Plus canonical form when recorded and executed")
    let keypad = press(69, "+", .command)
    try check(recorded == "Command+Plus" && ExplorerShortcuts.key(keypad) == recorded, "Keypad Plus matches the regular Plus binding")
    for (code, characters, value) in [(UInt16(36), "\r", "Enter"), (49, " ", "Space"), (51, "\u{7f}", "Backspace"), (117, String(UnicodeScalar(NSDeleteFunctionKey)!), "Delete"), (96, String(UnicodeScalar(NSF5FunctionKey)!), "F5")] {
      let event = press(code, characters)
      try check(recorded == value && error == nil && ExplorerShortcuts.key(event) == value, "Operation recorder accepts bare \(value)")
    }
    _ = press(0, "a"); try check(recorded == nil && error != nil, "Bare letters cannot replace file operation shortcuts")
    _ = press(0, "A", .shift); try check(recorded == nil && error != nil, "Shift alone does not enable letter shortcuts")
    _ = press(48, "\t"); try check(recorded == nil, "Bare Tab remains focus navigation during recording")
    _ = press(53, "\u{1b}"); try check(recorded == nil, "Escape ends recording without assigning a shortcut")
    let f24 = press(0, String(UnicodeScalar(NSF24FunctionKey)!))
    try check(recorded == "F24" && ExplorerShortcuts.key(f24) == "F24", "Function key character fallback supports the mainline F1 through F24 range")
    do { _ = try NativeSystemIntegration.keyBinding("Enter"); throw NSError(domain: "NativeShortcutChecks", code: 2) }
    catch { try check((error as NSError).domain != "NativeShortcutChecks", "Wake shortcut still rejects an unmodified Return") }
    try check(try NativeSystemIntegration.keyBinding("F5") != nil, "Wake shortcut retains its existing function-key rule")
    return checks
  }
}

private final class ShortcutFixtureEvent: NSEvent {
  var code: UInt16 = 0
  var text = ""
  var flags: NSEvent.ModifierFlags = []
  override var keyCode: UInt16 { code }
  override var charactersIgnoringModifiers: String? { text }
  override var characters: String? { text }
  override var modifierFlags: NSEvent.ModifierFlags { flags }
  override var type: NSEvent.EventType { .keyDown }
}
