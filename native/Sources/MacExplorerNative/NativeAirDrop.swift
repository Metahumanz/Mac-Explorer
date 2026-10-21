import Foundation
import CoreFoundation
import Darwin

enum AirDropDiscoveryError: Equatable { case unavailable, failed }

protocol AirDropDiscovering: AnyObject {
  var onChange: (([String], AirDropDiscoveryError?) -> Void)? { get set }
  func start()
  func stop()
}

// shortcut: discovery uses a private Sharing ABI; revisit when macOS changes it. Sending stays with NSSharingService.
final class NativeAirDrop: AirDropDiscovering {
  var onChange: (([String], AirDropDiscoveryError?) -> Void)?
  private(set) var callbackCount = 0
  var isRunning: Bool { browser != nil }
  private var browser: UnsafeRawPointer?
  private var session: Session?
  private lazy var functions: Functions? = Self.sharedFunctions

  private final class Session {
    weak var owner: NativeAirDrop?
    init(_ owner: NativeAirDrop) { self.owner = owner }
  }
  private struct Context {
    var version: CFIndex = 0
    var info: UnsafeMutableRawPointer?
    var retain: CFAllocatorRetainCallBack?
    var release: CFAllocatorReleaseCallBack?
    var description: CFAllocatorCopyDescriptionCallBack? = nil
  }
  private typealias Callback = @convention(c) (UnsafeRawPointer?, UnsafeRawPointer?, UnsafeRawPointer?, UInt, Int32, UnsafeMutableRawPointer?) -> Void
  private struct Functions {
    let create: @convention(c) (CFAllocator?, CFString) -> UnsafeRawPointer?
    let setQueue: @convention(c) (UnsafeRawPointer, DispatchQueue) -> Void
    let setClient: @convention(c) (UnsafeRawPointer, Callback, UnsafeRawPointer) -> Void
    let open: @convention(c) (UnsafeRawPointer, UnsafeRawPointer?, UnsafeRawPointer?, UInt) -> Void
    let children: @convention(c) (UnsafeRawPointer, UnsafeRawPointer?) -> UnsafeRawPointer?
    let invalidate: @convention(c) (UnsafeRawPointer) -> Void
    let name: @convention(c) (UnsafeRawPointer) -> UnsafeRawPointer?
    let kind: CFString

    static func load() -> Functions? {
      guard let handle = dlopen("/System/Library/PrivateFrameworks/Sharing.framework/Sharing", RTLD_LAZY | RTLD_LOCAL) else { return nil }
      func symbol<T>(_ name: String, _ type: T.Type) -> T? {
        guard let value = dlsym(handle, name) else { return nil }
        return unsafeBitCast(value, to: type)
      }
      guard let create = symbol("SFBrowserCreate", (@convention(c) (CFAllocator?, CFString) -> UnsafeRawPointer?).self),
        let setQueue = symbol("SFBrowserSetDispatchQueue", (@convention(c) (UnsafeRawPointer, DispatchQueue) -> Void).self),
        let setClient = symbol("SFBrowserSetClient", (@convention(c) (UnsafeRawPointer, Callback, UnsafeRawPointer) -> Void).self),
        let open = symbol("SFBrowserOpenNode", (@convention(c) (UnsafeRawPointer, UnsafeRawPointer?, UnsafeRawPointer?, UInt) -> Void).self),
        let children = symbol("SFBrowserCopyChildren", (@convention(c) (UnsafeRawPointer, UnsafeRawPointer?) -> UnsafeRawPointer?).self),
        let invalidate = symbol("SFBrowserInvalidate", (@convention(c) (UnsafeRawPointer) -> Void).self),
        let name = symbol("SFNodeCopyComputerName", (@convention(c) (UnsafeRawPointer) -> UnsafeRawPointer?).self),
        let kindAddress = dlsym(handle, "kSFBrowserKindAirDrop"),
        let kindPointer = kindAddress.load(as: UnsafeRawPointer?.self) else { return nil }
      let kind = Unmanaged<CFTypeRef>.fromOpaque(kindPointer).takeUnretainedValue()
      guard CFGetTypeID(kind) == CFStringGetTypeID() else { return nil }
      return Functions(create: create, setQueue: setQueue, setClient: setClient, open: open, children: children, invalidate: invalidate, name: name, kind: unsafeBitCast(kind, to: CFString.self))
    }
  }
  private static let sharedFunctions = Functions.load()

  func start() {
    precondition(Thread.isMainThread)
    stop(); callbackCount = 0
    guard let functions, let browser = functions.create(kCFAllocatorDefault, functions.kind) else { onChange?([], .unavailable); return }
    self.browser = browser
    let session = Session(self); self.session = session
    var context = Context(info: Unmanaged.passUnretained(session).toOpaque(), retain: { pointer in
      guard let pointer else { return nil }
      _ = Unmanaged<Session>.fromOpaque(pointer).retain(); return pointer
    }, release: { pointer in
      if let pointer { Unmanaged<Session>.fromOpaque(pointer).release() }
    })
    functions.setQueue(browser, DispatchQueue.main)
    withUnsafePointer(to: &context) { context in
      functions.setClient(browser, { _, _, _, _, error, info in
        guard let info else { return }
        let session = Unmanaged<Session>.fromOpaque(info).takeUnretainedValue()
        DispatchQueue.main.async { [session] in session.owner?.receive(session, error: error) }
      }, UnsafeRawPointer(context))
    }
    functions.open(browser, nil, nil, 0)
    onChange?([], nil)
  }
  private func receive(_ session: Session, error: Int32) {
    guard self.session === session, let browser, let functions else { return }
    callbackCount += 1
    guard error == 0 else { onChange?([], .failed); return }
    guard let pointer = functions.children(browser, nil) else { onChange?([], nil); return }
    let value = Unmanaged<CFTypeRef>.fromOpaque(pointer).takeRetainedValue()
    guard CFGetTypeID(value) == CFArrayGetTypeID() else { onChange?([], .failed); return }
    let children = unsafeBitCast(value, to: CFArray.self)
    var names: [String] = []
    for index in 0..<CFArrayGetCount(children) {
      guard let node = CFArrayGetValueAtIndex(children, index) else { continue }
      var name = ""
      if let pointer = functions.name(node) {
        let value = Unmanaged<CFTypeRef>.fromOpaque(pointer).takeRetainedValue()
        if CFGetTypeID(value) == CFStringGetTypeID() {
          let text = unsafeBitCast(value, to: CFString.self) as String
          name = String(String.UnicodeScalarView(text.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })).prefix(256).description
        }
      }
      names.append(name)
    }
    onChange?(names, nil)
  }
  func stop() {
    precondition(Thread.isMainThread)
    let previous = session; session = nil
    if let browser { functions?.invalidate(browser); Unmanaged<CFTypeRef>.fromOpaque(browser).release(); self.browser = nil }
    withExtendedLifetime(previous) {}
  }
  deinit {
    if let browser { functions?.invalidate(browser); Unmanaged<CFTypeRef>.fromOpaque(browser).release() }
  }
}
