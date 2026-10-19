import Foundation
import CoreServices

public struct FinderFavorite: Codable, Sendable {
  public let path: String
  public let name: String
  public init(path: String, name: String) { self.path = path; self.name = name }
}
public struct FinderFavoritesResult: Sendable {
  public let places: [FinderFavorite]
  public let skipped: Int
}
public enum FinderFavoritesReader {
  public static func filter(_ candidates: [FinderFavorite], skipped: Int = 0) -> FinderFavoritesResult {
    var seen = Set<String>(), places: [FinderFavorite] = [], skipped = skipped
    for candidate in candidates {
      guard candidate.path.hasPrefix("/"), !candidate.path.contains("\0") else { skipped += 1; continue }
      let url = URL(fileURLWithPath: candidate.path), resolved = url.resolvingSymlinksInPath()
      guard let values = try? resolved.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey]), values.isDirectory == true, values.isPackage != true else { skipped += 1; continue }
      guard seen.insert(resolved.path).inserted else { continue }
      places.append(FinderFavorite(path: url.standardizedFileURL.path, name: candidate.name.isEmpty ? url.lastPathComponent : candidate.name))
    }
    return FinderFavoritesResult(places: places, skipped: skipped)
  }
  public static func read() throws -> FinderFavoritesResult {
    // shortcut: Finder's read-only list API is deprecated; replace when Apple provides a supported replacement.
    guard let list = LSSharedFileListCreate(nil, kLSSharedFileListFavoriteItems.takeUnretainedValue(), nil)?.takeRetainedValue(),
          let snapshot = LSSharedFileListCopySnapshot(list, nil)?.takeRetainedValue() as? [LSSharedFileListItem] else {
      throw NSError(domain: "FinderFavorites", code: 1, userInfo: [NSLocalizedDescriptionKey: NL("无法读取 Finder 收藏夹。")])
    }
    var candidates: [FinderFavorite] = [], skipped = 0
    for item in snapshot {
      let flags = UInt32(kLSSharedFileListNoUserInteraction | kLSSharedFileListDoNotMountVolumes)
      guard let url = LSSharedFileListItemCopyResolvedURL(item, flags, nil)?.takeRetainedValue() as URL?, url.isFileURL else { skipped += 1; continue }
      candidates.append(FinderFavorite(path: url.path, name: LSSharedFileListItemCopyDisplayName(item).takeRetainedValue() as String))
    }
    return filter(candidates, skipped: skipped)
  }
}
