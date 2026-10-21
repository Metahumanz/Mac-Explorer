import Foundation
import Darwin

/// A paired, structurally valid AppleDouble is filesystem metadata, not an extra
/// data file. Native xattr copying preserves its streams through the primary file.
/// A ._ prefix alone never qualifies, nor does an unpaired or malformed file.
enum AppleDoubleCompanion {
  static func usesSidecars(_ directory: Int32) throws -> Bool {
    var filesystem = statfs()
    guard fstatfs(directory, &filesystem) == 0 else { throw VerifiedTransfer.posix() }
    return withUnsafePointer(to: &filesystem.f_fstypename) { $0.withMemoryRebound(to: CChar.self, capacity: 16) { String(cString: $0) == "smbfs" } }
  }
  static func stamp(in directory: Int32, primary: String, reader: ((Int32, UnsafeMutableRawPointer, Int, off_t) -> Int)? = nil) throws -> TransferStamp? {
    let name = "._" + primary
    guard name.utf8.count <= Int(NAME_MAX) else { return nil }
    var info = stat()
    guard fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
      if errno == ENOENT { return nil }; throw VerifiedTransfer.posix()
    }
    let precision = try usesSidecars(directory) ? 100 : 1
    var before = TransferStamp(info, precision: precision)
    guard before.type == S_IFREG, before.size >= 26 else { return nil }
    let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw VerifiedTransfer.posix() }; defer { close(fd) }
    guard fstat(fd, &info) == 0 else { throw VerifiedTransfer.posix() }
    let opened = TransferStamp(info, precision: precision)
    guard before.device == opened.device, before.inode == opened.inode, before.type == opened.type else { throw VerifiedTransfer.posix(ESTALE) }
    before = opened
    guard before.size >= 26 else { return nil }
    // Some SMB AppleDouble handles reject sequential read despite being readable.
    // Positioned reads also avoid depending on any shared stream offset.
    func readExactly(_ count: Int, at start: off_t) throws -> [UInt8] {
      var bytes = [UInt8](repeating: 0, count: count), offset = 0
      while offset < count {
        let amount = bytes.withUnsafeMutableBytes {
          let pointer = $0.baseAddress!.advanced(by: offset)
          let position = start + off_t(offset)
          return reader?(fd, pointer, count - offset, position) ?? pread(fd, pointer, count - offset, position)
        }
        if amount < 0 && errno == EINTR { continue }
        guard amount > 0 else { throw VerifiedTransfer.posix(amount < 0 ? errno : EIO) }
        offset += amount
      }
      return bytes
    }
    let header = try readExactly(26, at: 0)
    func word(_ bytes: [UInt8], _ index: Int) -> UInt32 {
      bytes[index..<index+4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    }
    guard word(header, 0) == 0x00051607, word(header, 4) == 0x00020000 else { return nil }
    let count = Int(header[24]) << 8 | Int(header[25])
    guard count > 0, count <= 16, before.size >= 26 + count * 12 else { return nil }
    let table = try readExactly(count * 12, at: 26)
    var identifiers = Set<UInt32>()
    for index in 0..<count {
      let entry = index * 12, id = word(table, entry)
      let offset = UInt64(word(table, entry + 4)), length = UInt64(word(table, entry + 8))
      guard [UInt32(2), UInt32(9)].contains(id), identifiers.insert(id).inserted,
            offset >= UInt64(26 + table.count), offset + length <= UInt64(before.size) else { return nil }
    }
    guard fstat(fd, &info) == 0, before.unchanged(TransferStamp(info, precision: precision)) else { throw VerifiedTransfer.posix(ESTALE) }
    return before
  }

  static func isMetadata(_ name: String, in directory: Int32) throws -> Bool {
    guard name.hasPrefix("._"), name.count > 2 else { return false }
    guard try usesSidecars(directory) else { return false }
    let primary = String(name.dropFirst(2))
    var info = stat()
    guard fstatat(directory, primary, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return false }
    return try stamp(in: directory, primary: primary) != nil
  }

  static func remove(in directory: Int32, primary: String, expected: TransferStamp?) throws {
    guard let expected else { return }
    guard try usesSidecars(directory) else { return }
    var info = stat()
    let name = "._" + primary
    if fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) != 0 {
      if errno == ENOENT { return }; throw VerifiedTransfer.posix()
    }
    guard expected.unchanged(TransferStamp(info, precision: expected.precision)) else { throw VerifiedTransfer.posix(ESTALE) }
    if unlinkat(directory, name, 0) != 0, errno != ENOENT { throw VerifiedTransfer.posix() }
  }
}
