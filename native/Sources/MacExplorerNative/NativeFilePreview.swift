import Foundation
import ExplorerCore

struct NativeFilePreview: Sendable {
  var image: Data?
  var text: String?
  var truncated = false

  static func read(_ entry: FileEntry) throws -> NativeFilePreview {
    guard !entry.isDirectory else { return NativeFilePreview() }
    let ext = entry.url.pathExtension.lowercased()
    if ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"].contains(ext), entry.size < 12 * 1024 * 1024 {
      let handle = try FileHandle(forReadingFrom: entry.url); defer { try? handle.close() }
      let data = try handle.read(upToCount: 12 * 1024 * 1024) ?? Data()
      return NativeFilePreview(image: data)
    }
    guard ["txt", "md", "json", "js", "jsx", "ts", "tsx", "css", "html", "xml", "yaml", "yml", "toml", "csv", "log", "swift", "py", "go", "rs", "sh", "sql", "gitignore", ""].contains(ext) else { return NativeFilePreview() }
    let handle = try FileHandle(forReadingFrom: entry.url); defer { try? handle.close() }
    let data = try handle.read(upToCount: 16_384) ?? Data()
    guard !data.contains(0) else { return NativeFilePreview() }
    return NativeFilePreview(text: String(decoding: data, as: UTF8.self), truncated: entry.size > data.count)
  }
}
