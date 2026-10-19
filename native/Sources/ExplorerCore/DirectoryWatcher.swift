import Foundation
import Dispatch
import Darwin

/// Watches one directory's vnode, not a recursive tree or the contents of its files.
/// Creating, renaming, and removing entries normally produce events; in-place writes
/// to an existing child's contents need not do so. Notifications are hints to reload.
///
/// Call `watch` and `stop` on the main thread. Callbacks run on the main queue after
/// 150 ms of quiet. A rename, deletion, or revocation of the watched directory emits
/// one final notification and ends that watch; it does not follow the moved inode.
///
/// Opening is asynchronous, so changes before the watch is armed may be missed.
/// Perform an initial directory load independently. Invalid/unavailable directories
/// silently leave the watcher stopped. Local file URLs can still refer to network
/// mounts: a blocked open never blocks the main thread, but cannot be interrupted
/// and delays subsequent opens on this watcher's serial opening queue.
public final class DirectoryWatcher {
    private final class OpenRequest {
        private let lock = NSLock()
        private var cancelled = false

        var isCancelled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return cancelled
        }

        func cancel() {
            lock.lock()
            cancelled = true
            lock.unlock()
        }
    }

    private let openingQueue = DispatchQueue(label: "ExplorerCore.DirectoryWatcher.open", qos: .utility)
    private var source: DispatchSourceFileSystemObject?
    private var pendingOpen: OpenRequest?
    private var pendingDelivery: DispatchWorkItem?
    private var generation: UInt64 = 0
    private var deliverySequence: UInt64 = 0

    public init() {}

    /// Replaces the previous watch, including any pending open or notification.
    /// Accepts absolute file URLs with no authority except an optional localhost,
    /// and no credentials, port, query, fragment, base URL, or embedded NUL.
    /// Symlinks to directories are followed; no directory or file is modified.
    public func watch(_ directory: URL?, onChange: @escaping () -> Void) {
        precondition(Thread.isMainThread, "DirectoryWatcher.watch must run on the main thread")
        stop()
        guard let directory, let path = Self.localPath(directory) else { return }

        let request = OpenRequest()
        let requestedGeneration = generation
        pendingOpen = request
        openingQueue.async { [weak self] in
            guard !request.isCancelled else { return }
            let descriptor = path.withCString { Darwin.open($0, O_EVTONLY | O_DIRECTORY | O_CLOEXEC) }
            guard descriptor >= 0 else { return }
            guard !request.isCancelled else {
                Darwin.close(descriptor)
                return
            }

            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == requestedGeneration, !request.isCancelled else {
                    // No dispatch source owns this descriptor yet. Even this
                    // stale-open cleanup stays off-main for network mounts.
                    DispatchQueue.global(qos: .utility).async { Darwin.close(descriptor) }
                    return
                }
                self.pendingOpen = nil
                self.start(descriptor, generation: requestedGeneration, onChange: onChange)
            }
        }
    }

    /// Cancels notifications immediately; descriptor closure is asynchronous.
    public func stop() {
        precondition(Thread.isMainThread, "DirectoryWatcher.stop must run on the main thread")
        generation &+= 1
        pendingOpen?.cancel()
        pendingOpen = nil
        pendingDelivery?.cancel()
        pendingDelivery = nil
        source?.cancel()
        source = nil
    }

    deinit {
        pendingOpen?.cancel()
        pendingDelivery?.cancel()
        source?.cancel()
    }

    private static func localPath(_ url: URL) -> String? {
        guard url.isFileURL, url.baseURL == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "file",
              components.user == nil, components.password == nil, components.port == nil,
              components.query == nil, components.fragment == nil else { return nil }
        if let host = components.host, !host.isEmpty, host.lowercased() != "localhost" {
            return nil
        }
        let path = components.path
        guard path.hasPrefix("/"), !path.utf8.contains(0) else { return nil }
        return path
    }

    private func start(_ descriptor: Int32, generation: UInt64, onChange: @escaping () -> Void) {
        // A background target also keeps cancellation/close off the main queue.
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .delete, .rename, .attrib, .revoke],
            queue: DispatchQueue.global(qos: .utility)
        )
        source.setCancelHandler { Darwin.close(descriptor) }
        source.setEventHandler { [weak self, weak source] in
            guard let events = source?.data, !events.isEmpty else { return }
            DispatchQueue.main.async { [weak self] in
                self?.received(events, generation: generation, onChange: onChange)
            }
        }
        self.source = source
        // Every created source is activated exactly once, even if stop follows
        // immediately. Cancelling a suspended source would strand its descriptor.
        source.activate()
    }

    private func received(
        _ events: DispatchSource.FileSystemEvent,
        generation: UInt64,
        onChange: @escaping () -> Void
    ) {
        guard self.generation == generation, let source else { return }
        if !events.intersection([.delete, .rename, .revoke]).isEmpty {
            self.source = nil
            source.cancel()
        }

        pendingDelivery?.cancel()
        deliverySequence &+= 1
        let sequence = deliverySequence
        let delivery = DispatchWorkItem { [weak self] in
            guard let self, self.generation == generation, self.deliverySequence == sequence else { return }
            self.pendingDelivery = nil
            onChange()
        }
        pendingDelivery = delivery
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(150), execute: delivery)
    }
}
