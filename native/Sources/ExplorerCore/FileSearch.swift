import Foundation

public struct FileSearchResult: Sendable {
  public let entries: [FileEntry]
  public let truncated: Bool
  public let skipped: Int
}
public enum FileSearch {
  public static func search(in directory: URL, query: String, showHidden: Bool) throws -> FileSearchResult {
    var queue = [directory], cursor = 0, visited = 0, skipped = 0
    var matches: [FileEntry] = []
    while cursor < queue.count && visited < 30_000 && matches.count < 1_000 {
      try Task.checkCancellation()
      let current = queue[cursor]; cursor += 1
      let snapshot: DirectorySnapshot
      do { snapshot = try DirectoryReader.read(current) }
      catch is CancellationError { throw CancellationError() }
      catch { if cursor == 1 { throw error }; skipped += 1; continue }
      skipped += snapshot.skippedCount
      for entry in snapshot.entries where showHidden || !entry.isHidden {
        try Task.checkCancellation(); visited += 1
        if entry.name.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil { matches.append(entry) }
        if entry.isDirectory && !entry.isSymbolicLink && !entry.isPackage { queue.append(entry.url) }
        if visited >= 30_000 || matches.count >= 1_000 { break }
      }
    }
    return FileSearchResult(entries: matches, truncated: visited >= 30_000 || matches.count >= 1_000, skipped: skipped)
  }
}
