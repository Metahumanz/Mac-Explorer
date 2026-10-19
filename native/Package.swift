// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "MacExplorerNative",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "MacExplorerNative", targets: ["MacExplorerNative"])],
  targets: [
    .target(name: "ExplorerCore"),
    .executableTarget(name: "MacExplorerNative", dependencies: ["ExplorerCore"]),
    .testTarget(name: "ExplorerCoreTests", dependencies: ["ExplorerCore"]),
  ]
)
