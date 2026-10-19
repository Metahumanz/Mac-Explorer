// Standalone fixture-only checks; no XCTest or application sources are required.
// From the repository root:
//   swiftc -swift-version 5 -parse-as-library \
//     native/Sources/ExplorerCore/DirectoryWatcher.swift \
//     native/scripts/WatcherChecks.swift -o /tmp/watcher-checks
//   /tmp/watcher-checks
// Each check owns a fresh temporary directory and removes only its own fixtures.
import Foundation
import Darwin

private struct CheckFailure: Error, CustomStringConvertible {
    let description: String
}

private final class WeakWatcher {
    weak var value: DirectoryWatcher?

    init(_ value: DirectoryWatcher?) {
        self.value = value
    }
}

@MainActor
private final class ChangeLog {
    var count = 0
    var allOnMain = true

    func record() {
        count += 1
        allOnMain = allOnMain && Thread.isMainThread
    }
}

@main
@MainActor
struct WatcherChecks {
    private static let files = FileManager.default

    static func main() async {
        let checks: [(String, (URL) async throws -> Void)] = [
            ("child creation and main-queue delivery", childCreation),
            ("child rename", childRename),
            ("child removal", childRemoval),
            ("burst coalescing", burstCoalescing),
            ("switch cancels old events and pending delivery", switchDirectory),
            ("rapid switches keep only the latest generation", rapidSwitches),
            ("stop suppresses pending and subsequent delivery", stopped),
            ("watch(nil) suppresses pending and subsequent delivery", nilDirectory),
            ("invalid URLs are rejected and replace the old watch", invalidURLs),
            ("missing directory is graceful and not retried", missingDirectory),
            ("regular files are not watched", regularFile),
            ("watched directory rename reports once", directoryRename),
            ("watched directory deletion reports once", directoryDeletion),
            ("directory attribute change", attributes),
            ("local directory symlink", directorySymlink),
            ("localhost file URL", localhostURL),
            ("deinit suppresses pending delivery without retention", destruction),
            ("cancelled opens and activated sources release descriptors", descriptorLifetime),
        ]
        var failures = 0
        for (name, check) in checks {
            let root = files.temporaryDirectory.appendingPathComponent(
                "MacExplorer-WatcherChecks-\(UUID().uuidString)", isDirectory: true
            )
            do {
                try files.createDirectory(at: root, withIntermediateDirectories: false)
                defer { try? files.removeItem(at: root) }
                try await check(root)
                print("PASS \(name)")
            } catch {
                failures += 1
                print("FAIL \(name): \(error)")
            }
        }
        print("\(checks.count - failures)/\(checks.count) watcher checks passed")
        if failures != 0 { Darwin.exit(1) }
    }

    private static func expect(_ value: @autoclosure () -> Bool, _ message: String) throws {
        if !value() { throw CheckFailure(description: message) }
    }

    private static func pause(_ milliseconds: UInt64 = 350) async throws {
        try await Task.sleep(nanoseconds: milliseconds * 1_000_000)
    }

    private static func child(_ root: URL, _ name: String) throws -> URL {
        let url = root.appendingPathComponent(name)
        try Data(name.utf8).write(to: url, options: .withoutOverwriting)
        return url
    }

    private static func directory(_ root: URL, _ name: String) throws -> URL {
        let url = root.appendingPathComponent(name, isDirectory: true)
        try files.createDirectory(at: url, withIntermediateDirectories: false)
        return url
    }

    private static func waitForChange(_ log: ChangeLog) async throws {
        let deadline = Date().addingTimeInterval(3)
        while log.count == 0, Date() < deadline { try await pause(20) }
        try expect(log.count > 0, "No notification within three seconds")
        try expect(log.allOnMain, "Notification did not run on the main thread")
    }

    // The public API intentionally has no readiness callback. Probe only the fresh
    // fixture until a notification proves the asynchronous open is armed, then
    // remove the probes and let their notifications settle before each assertion.
    private static func arm(_ watcher: DirectoryWatcher, at root: URL, log: ChangeLog) async throws {
        watcher.watch(root) { log.record() }
        var probes: [URL] = []
        for index in 0..<10 {
            probes.append(try child(root, ".arm-\(index)"))
            try await pause(250)
            if log.count > 0 { break }
        }
        try expect(log.count > 0, "Watch did not arm within 2.5 seconds")
        try expect(log.allOnMain, "Readiness notification was not on the main thread")
        for probe in probes { try files.removeItem(at: probe) }
        try await pause()
        log.count = 0
    }

    private static func childCreation(_ root: URL) async throws {
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        try await arm(watcher, at: root, log: log)
        _ = try child(root, "created")
        try await waitForChange(log)
    }

    private static func childRename(_ root: URL) async throws {
        let original = try child(root, "before")
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        try await arm(watcher, at: root, log: log)
        try files.moveItem(at: original, to: root.appendingPathComponent("after"))
        try await waitForChange(log)
    }

    private static func childRemoval(_ root: URL) async throws {
        let original = try child(root, "removed")
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        try await arm(watcher, at: root, log: log)
        try files.removeItem(at: original)
        try await waitForChange(log)
    }

    private static func burstCoalescing(_ root: URL) async throws {
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        try await arm(watcher, at: root, log: log)
        for index in 0..<12 { _ = try child(root, "burst-\(index)") }
        try await waitForChange(log)
        try await pause()
        try expect(log.count == 1, "One burst emitted \(log.count) notifications")
    }

    private static func switchDirectory(_ root: URL) async throws {
        let first = try directory(root, "first")
        let second = try directory(root, "second")
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let old = ChangeLog()
        let new = ChangeLog()
        try await arm(watcher, at: first, log: old)
        _ = try child(first, "pending")
        try await pause(40)
        try await arm(watcher, at: second, log: new)
        _ = try child(first, "ignored")
        _ = try child(second, "observed")
        try await waitForChange(new)
        try await pause()
        try expect(old.count == 0, "Old-generation delivery escaped navigation")
        try expect(new.count == 1, "New directory did not emit exactly once")
    }

    private static func rapidSwitches(_ root: URL) async throws {
        let first = try directory(root, "first")
        let second = try directory(root, "second")
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let old = ChangeLog()
        let new = ChangeLog()
        for index in 0..<80 {
            watcher.watch(index.isMultiple(of: 2) ? first : second) { old.record() }
        }
        try await arm(watcher, at: second, log: new)
        _ = try child(first, "ignored")
        _ = try child(second, "observed")
        try await waitForChange(new)
        try await pause()
        try expect(old.count == 0, "An obsolete asynchronous open became active")
        try expect(new.count == 1, "Latest watch did not observe the new directory")
    }

    private static func stopped(_ root: URL) async throws {
        let watcher = DirectoryWatcher()
        let log = ChangeLog()
        try await arm(watcher, at: root, log: log)
        _ = try child(root, "pending")
        try await pause(40)
        watcher.stop()
        watcher.stop()
        _ = try child(root, "after-stop")
        try await pause()
        try expect(log.count == 0, "Delivery occurred after stop")
    }

    private static func nilDirectory(_ root: URL) async throws {
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        try await arm(watcher, at: root, log: log)
        _ = try child(root, "pending")
        try await pause(40)
        watcher.watch(nil) { log.record() }
        _ = try child(root, "after-nil")
        try await pause()
        try expect(log.count == 0, "Delivery occurred after watch(nil)")
    }

    private static func invalidURLs(_ root: URL) async throws {
        let base = URLComponents(url: root, resolvingAgainstBaseURL: false)!
        var variants: [URL] = []
        var candidate = base
        candidate.scheme = "https"
        candidate.host = "example.invalid"
        variants.append(candidate.url!)
        candidate = base
        candidate.host = "remote.invalid"
        variants.append(candidate.url!)
        candidate = base
        candidate.host = "localhost"
        candidate.user = "user"
        candidate.password = "password"
        variants.append(candidate.url!)
        candidate = base
        candidate.host = "localhost"
        candidate.port = 1234
        variants.append(candidate.url!)
        candidate = base
        candidate.query = "ignored=true"
        variants.append(candidate.url!)
        candidate = base
        candidate.fragment = "ignored"
        variants.append(candidate.url!)
        candidate = base
        candidate.path = root.path + "\0ignored"
        variants.append(candidate.url!)
        variants.append(URL(string: "relative-directory")!)
        variants.append(URL(string: ".", relativeTo: root)!)

        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        for (index, invalid) in variants.enumerated() {
            try await arm(watcher, at: root, log: log)
            watcher.watch(invalid) { log.record() }
            try await pause(100)
            _ = try child(root, "invalid-\(index)")
            try await pause()
            try expect(log.count == 0, "Invalid URL accepted or old watch retained: \(invalid)")
        }
    }

    private static func missingDirectory(_ root: URL) async throws {
        let missing = root.appendingPathComponent("missing", isDirectory: true)
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        watcher.watch(missing) { log.record() }
        try await pause()
        try files.createDirectory(at: missing, withIntermediateDirectories: false)
        _ = try child(missing, "later")
        try await pause()
        try expect(log.count == 0, "Unavailable directory unexpectedly became watched")
    }

    private static func regularFile(_ root: URL) async throws {
        let file = try child(root, "file")
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        watcher.watch(file) { log.record() }
        try await pause()
        try Data("updated".utf8).write(to: file)
        try files.removeItem(at: file)
        try await pause()
        try expect(log.count == 0, "A regular file was watched as a directory")
    }

    private static func directoryRename(_ root: URL) async throws {
        let watched = try directory(root, "watched")
        let renamed = root.appendingPathComponent("renamed", isDirectory: true)
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        try await arm(watcher, at: watched, log: log)
        try files.moveItem(at: watched, to: renamed)
        try await waitForChange(log)
        _ = try child(renamed, "must-not-follow")
        try await pause()
        try expect(log.count == 1, "Directory rename was not a single final notification")
    }

    private static func directoryDeletion(_ root: URL) async throws {
        let watched = try directory(root, "watched")
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        try await arm(watcher, at: watched, log: log)
        try files.removeItem(at: watched)
        try await waitForChange(log)
        try files.createDirectory(at: watched, withIntermediateDirectories: false)
        _ = try child(watched, "replacement-is-not-watched")
        try await pause()
        try expect(log.count == 1, "Directory removal was not a single final notification")
    }

    private static func attributes(_ root: URL) async throws {
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        try await arm(watcher, at: root, log: log)
        try files.setAttributes([.posixPermissions: 0o750], ofItemAtPath: root.path)
        try await waitForChange(log)
    }

    private static func directorySymlink(_ root: URL) async throws {
        let target = try directory(root, "target")
        let link = root.appendingPathComponent("link", isDirectory: true)
        try files.createSymbolicLink(at: link, withDestinationURL: target)
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        try await arm(watcher, at: link, log: log)
        _ = try child(target, "through-target")
        try await waitForChange(log)
        let destination = try files.destinationOfSymbolicLink(atPath: link.path)
        try expect(destination == target.path, "Watcher changed the symlink")
    }

    private static func localhostURL(_ root: URL) async throws {
        var components = URLComponents(url: root, resolvingAgainstBaseURL: false)!
        components.host = "localhost"
        let watcher = DirectoryWatcher()
        defer { watcher.stop() }
        let log = ChangeLog()
        try await arm(watcher, at: components.url!, log: log)
        _ = try child(root, "local")
        try await waitForChange(log)
    }

    private static func destruction(_ root: URL) async throws {
        var watcher: DirectoryWatcher? = DirectoryWatcher()
        let weakWatcher = WeakWatcher(watcher)
        let log = ChangeLog()
        try await arm(watcher!, at: root, log: log)
        _ = try child(root, "pending")
        try await pause(40)
        watcher = nil
        try expect(weakWatcher.value == nil, "Background work or delivery retained the watcher")
        _ = try child(root, "after-deinit")
        try await pause()
        try expect(log.count == 0, "Delivery occurred after deinit")
    }

    // Count only this process's descriptor slots; no file paths or private files
    // are inspected. Earlier checks have already warmed the dispatch machinery.
    private static func openDescriptorCount() -> Int {
        var count = 0
        for descriptor in 0..<getdtablesize() {
            if fcntl(descriptor, F_GETFD) >= 0 { count += 1 }
        }
        return count
    }

    private static func descriptorLifetime(_ root: URL) async throws {
        try await pause()
        let baseline = openDescriptorCount()
        let log = ChangeLog()
        let reusable = DirectoryWatcher()
        defer { reusable.stop() }
        for index in 0..<120 {
            if index.isMultiple(of: 3) {
                reusable.watch(root) { log.record() }
                reusable.stop() // Cancel while the open may still be queued/running.
            } else {
                var transient: DirectoryWatcher? = DirectoryWatcher()
                let weakWatcher = WeakWatcher(transient)
                transient?.watch(root) { log.record() }
                if index.isMultiple(of: 2) { try await pause(10) }
                transient = nil // Exercise both pending opens and activated sources.
                try expect(weakWatcher.value == nil, "A discarded watcher was retained")
            }
        }
        _ = try child(root, "after-lifetime-check")
        try await pause(500)
        try expect(log.count == 0, "A discarded watcher delivered a callback")
        let remaining = openDescriptorCount()
        try expect(remaining <= baseline, "Descriptor leak: baseline \(baseline), final \(remaining)")
    }
}
