import AppKit
import Darwin
import ExplorerCore
import SMBTransport

/// One authenticated connection per confirmed root. It never reconnects or falls back to POSIX.
final class NativeSMBDeletionProvider: NetworkDeletionHandleProvider, @unchecked Sendable {
  let accounts: NativeSMBAccounts
  let control: FileTransferControl
  let login: NativeSMBDataCopier.Login
  let saveFailure: @Sendable (OSStatus) -> Void
  init(control: FileTransferControl, accounts: NativeSMBAccounts = .shared, login: @escaping NativeSMBDataCopier.Login, saveFailure: @escaping @Sendable (OSStatus) -> Void) {
    self.control = control; self.accounts = accounts; self.login = login; self.saveFailure = saveFailure
  }
  func prepare(source: URL, parentDescriptor: Int32, entries: [NetworkDeletionEntry]) throws -> NetworkDeletionHandles {
    guard !control.isCancelled else { throw CancellationError() }
    guard !entries.isEmpty, entries.count <= 256, entries.allSatisfy({ $0.type == S_IFREG || $0.type == S_IFDIR }),
      let location = SMBMountedLocation.read(descriptor: parentDescriptor, file: source), !location.remotePath.isEmpty else {
      throw NetworkDeletionHandleFailure(code: ENOTSUP)
    }
    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST)); var port: UInt16 = 0
    guard mx_smb_mount_address(parentDescriptor, &host, host.count, &port) == 0 else { throw NetworkDeletionHandleFailure(code: ENOTSUP) }
    let address = String(cString: host)
    let endpoint = (address.contains(":") ? "[\(address)]" : address) + ":\(port)"
    let key = location.authority + "\n" + location.account.lowercased()
    var credential = accounts.load(key), failure: Int32?
    if credential?.isValid != true { credential = nil }
    var connection: OpaquePointer?
    while connection == nil {
      if control.isCancelled { throw CancellationError() }
      if credential == nil || failure != nil { credential = login(location.authority, location.account, credential, failure) }
      guard let value = credential, value.isValid else { throw CancellationError() }
      var code: Int32 = 0
      connection = mx_smb_connect(endpoint, location.share, location.share, value.user, value.domain, value.password, value.encrypted ? 1 : 0, &code)
      if connection == nil { failure = code; continue }
      let status = accounts.store(value, key: key); if status != errSecSuccess { saveFailure(status) }
    }
    guard let connection else { throw NetworkDeletionHandleFailure(code: ENOTCONN) }
    let handles = NativeSMBDeletionHandles(connection: connection, control: control)
    do {
      var code: Int32 = 0
      let context = Unmanaged.passUnretained(control).toOpaque()
      guard let group = mx_smb_delete_begin(connection, location.root.path, location.remotePath, { pointer in
        guard let pointer else { return 1 }; return Unmanaged<FileTransferControl>.fromOpaque(pointer).takeUnretainedValue().isCancelled ? 1 : 0
      }, context, &code) else { throw NetworkDeletionHandleFailure(code: code) }
      handles.group = group
      let prefix = String(location.remotePath.dropLast(source.lastPathComponent.count))
      for entry in entries {
        var stamp = mx_smb_delete_stamp(inode: entry.inode, size: entry.size, birth_seconds: entry.birthSeconds, birth_nanos: entry.birthNanos,
          modified_seconds: entry.modifiedSeconds, modified_nanos: entry.modifiedNanos, type: entry.type)
        let path = prefix + entry.path
        guard mx_smb_delete_bind(group, path, &stamp, &code) == MX_SMB_COPIED else { throw NetworkDeletionHandleFailure(code: code) }
        handles.paths[entry.path] = path
      }
      return handles
    } catch { handles.finish(); throw error }
  }
}
private final class NativeSMBDeletionHandles: NetworkDeletionHandles {
  private var connection: OpaquePointer?
  var group: OpaquePointer?
  var paths: [String: String] = [:]
  let control: FileTransferControl
  init(connection: OpaquePointer, control: FileTransferControl) { self.connection = connection; self.control = control }
  deinit { finish() }
  func remove(path: String) throws {
    guard !control.isCancelled else { throw CancellationError() }
    guard let group, let remotePath = paths[path] else { throw NetworkDeletionHandleFailure(code: ESTALE) }
    var code: Int32 = 0
    let result = mx_smb_delete_commit(group, remotePath, &code)
    if result != MX_SMB_COPIED { throw NetworkDeletionHandleFailure(code: code, uncertain: result == MX_SMB_UNCERTAIN) }
    paths.removeValue(forKey: path)
  }
  func finish() {
    if let group { mx_smb_delete_end(group); self.group = nil }
    if let connection { mx_smb_destroy(connection); self.connection = nil }
  }
}

private final class NativeDeletionLoginReply: @unchecked Sendable {
  let semaphore = DispatchSemaphore(value: 0)
  var credential: NativeSMBCredential?
}
@MainActor
extension BrowserController {
  func networkDeletionProvider(panel: NativeTransferPanel, control: FileTransferControl) -> NetworkDeletionHandleProvider {
    NativeSMBDeletionProvider(control: control, login: { [weak panel] server, account, previous, error in
      let reply = NativeDeletionLoginReply()
      DispatchQueue.main.async {
        guard let panel else { reply.semaphore.signal(); return }
        panel.login(server: server, account: account, previous: previous, error: error, deletion: true) { value in reply.credential = value; reply.semaphore.signal() }
      }
      reply.semaphore.wait(); return reply.credential
    }, saveFailure: { [weak panel] code in
      let reply = NativeDeletionLoginReply()
      DispatchQueue.main.async {
        guard let panel else { reply.semaphore.signal(); return }
        let alert = NSAlert(); alert.messageText = NL("无法保存登录信息"); alert.informativeText = NL("钥匙串错误码：{0}", String(code))
        panel.present(alert) { _ in reply.semaphore.signal() }
      }
      reply.semaphore.wait()
    })
  }
}
