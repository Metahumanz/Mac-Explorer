// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "MacExplorerNative",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "MacExplorerNative", targets: ["MacExplorerNative"])],
  targets: [
    .target(name: "ExplorerCore"),
    .target(
      name: "CSMB2", path: "Vendor/libsmb2",
      exclude: ["COPYING", "LICENCE-LGPL-2.1.txt", "README.mac-explorer.md"],
      sources: [
        "lib/aes.c", "lib/aes_reference.c", "lib/aes128ccm.c",
        "lib/alloc.c", "lib/asn1-ber.c", "lib/compat.c",
        "lib/errors.c", "lib/hmac.c", "lib/hmac-md5.c",
        "lib/init.c", "lib/libsmb2.c", "lib/md4c.c",
        "lib/md5.c", "lib/ntlmssp.c", "lib/pdu.c",
        "lib/quic.c", "lib/smbdirect.c", "lib/sha1.c",
        "lib/sha224-256.c", "lib/sha384-512.c", "lib/smb2-cmd-cancel.c",
        "lib/smb2-cmd-close.c", "lib/smb2-cmd-create.c", "lib/smb2-cmd-echo.c",
        "lib/smb2-cmd-error.c", "lib/smb2-cmd-flush.c", "lib/smb2-cmd-ioctl.c",
        "lib/smb2-cmd-lock.c", "lib/smb2-cmd-logoff.c", "lib/smb2-cmd-negotiate.c",
        "lib/smb2-cmd-notify-change.c", "lib/smb2-cmd-oplock-break.c", "lib/smb2-cmd-query-directory.c",
        "lib/smb2-cmd-query-info.c", "lib/smb2-cmd-read.c", "lib/smb2-cmd-session-setup.c",
        "lib/smb2-cmd-set-info.c", "lib/smb2-cmd-tree-connect.c", "lib/smb2-cmd-tree-disconnect.c",
        "lib/smb2-cmd-write.c", "lib/smb2-data-file-info.c", "lib/smb2-data-filesystem-info.c",
        "lib/smb2-data-security-descriptor.c", "lib/smb2-data-reparse-point.c", "lib/smb2-share-enum.c",
        "lib/smb3-seal.c", "lib/smb2-signing.c", "lib/socket.c",
        "lib/spnego-wrapper.c", "lib/sync.c", "lib/timestamps.c",
        "lib/unicode.c", "lib/usha.c", "lib/aes_apple.c"
      ],
      publicHeadersPath: "include",
      cSettings: [.define("HAVE_CONFIG_H"), .define("_FILE_OFFSET_BITS", to: "64"), .define("_U_", to: "__attribute__((unused))"), .headerSearchPath("include/smb2"), .headerSearchPath("lib")]
    ),
    .target(name: "SMBTransport", dependencies: ["CSMB2"]),
    .executableTarget(name: "MacExplorerNative", dependencies: ["ExplorerCore", "SMBTransport"]),
    .testTarget(name: "ExplorerCoreTests", dependencies: ["ExplorerCore"]),
  ]
)
