import Foundation
import CoreServices

struct Favorite: Codable { let path: String; let name: String }
struct Place: Codable { let path: String; let name: String; let icon: String }
struct Favorites: Codable { let places: [Place]; let skipped: Int }

func readFavorites() throws -> Favorites {
    var candidates: [Favorite] = []
    var skipped = 0
    if let root = ProcessInfo.processInfo.environment["EXPLORER_TEST_ROOT"] {
        candidates = try JSONDecoder().decode([Favorite].self, from: Data(contentsOf: URL(fileURLWithPath: root).appendingPathComponent("finder-favorites.json")))
    } else {
        // shortcut: Finder's read-only list API is deprecated; replace it when macOS offers a supported replacement.
        guard let list = LSSharedFileListCreate(nil, kLSSharedFileListFavoriteItems.takeUnretainedValue(), nil)?.takeRetainedValue(),
              let snapshot = LSSharedFileListCopySnapshot(list, nil)?.takeRetainedValue() as? [LSSharedFileListItem] else {
            throw NSError(domain: "FinderFavorites", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法读取 Finder 收藏夹。"])
        }
        for item in snapshot {
            let flags = UInt32(kLSSharedFileListNoUserInteraction | kLSSharedFileListDoNotMountVolumes)
            guard let url = LSSharedFileListItemCopyResolvedURL(item, flags, nil)?.takeRetainedValue() as URL?, url.isFileURL else { skipped += 1; continue }
            let name = LSSharedFileListItemCopyDisplayName(item).takeRetainedValue() as String
            candidates.append(Favorite(path: url.path, name: name))
        }
    }
    var seen = Set<String>()
    var places: [Place] = []
    for item in candidates {
        guard item.path.hasPrefix("/"), !item.path.contains("\0") else { skipped += 1; continue }
        let url = URL(fileURLWithPath: item.path)
        let resolved = url.resolvingSymlinksInPath()
        guard let values = try? resolved.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey]), values.isDirectory == true, values.isPackage != true else { skipped += 1; continue }
        guard seen.insert(resolved.path).inserted else { continue }
        places.append(Place(path: url.path, name: item.name.isEmpty ? url.lastPathComponent : item.name, icon: "folder"))
    }
    return Favorites(places: places, skipped: skipped)
}

do { FileHandle.standardOutput.write(try JSONEncoder().encode(readFavorites())) }
catch { FileHandle.standardError.write(Data("无法读取 Finder 收藏夹。".utf8)); exit(1) }
