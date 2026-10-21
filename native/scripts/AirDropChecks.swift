import Foundation

@main
enum AirDropChecks {
  static func main() {
    let browser = NativeAirDrop()
    var updates = 0
    var failure: AirDropDiscoveryError?
    browser.onChange = { _, error in updates += 1; failure = error }
    browser.start()
    precondition(browser.isRunning, "Private discovery must start on the test Mac")
    RunLoop.current.run(until: Date().addingTimeInterval(3))
    precondition(browser.callbackCount > 0 && failure == nil, "Real discovery callbacks must arrive without errors")
    let callbacks = browser.callbackCount
    browser.stop()
    precondition(!browser.isRunning, "Discovery must stop")
    let stoppedUpdates = updates
    RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    precondition(updates == stoppedUpdates, "Stopped sessions must reject queued callbacks")
    browser.start(); browser.stop()
    precondition(!browser.isRunning, "Restarted discovery must stop")
    weak var released: NativeAirDrop?
    do {
      var temporary: NativeAirDrop? = NativeAirDrop()
      released = temporary; temporary?.start(); temporary = nil
    }
    precondition(released == nil, "The browser callback context must not retain its owner")
    RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    print("AirDrop discovery: 6 live lifecycle checks passed; \(callbacks) system callbacks; no file transfer.")
  }
}
