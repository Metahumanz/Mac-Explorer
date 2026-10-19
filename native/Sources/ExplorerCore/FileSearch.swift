import Foundation

public struct FileSearchResult: Sendable {
  public let entries: [FileEntry]
  public let truncated: Bool
  public let skipped: Int
}
public enum FileSearchMode: String, Sendable {
  case text, wildcard, regex
}

public enum FileSearch {
  public static func search(in directory: URL, query: String, showHidden: Bool, mode: FileSearchMode = .text) throws -> FileSearchResult {
    let expression: NSRegularExpression?
    if mode == .text { expression = nil } else {
      let pattern = mode == .wildcard
        ? "\\A" + query.map { $0 == "*" ? ".*" : $0 == "?" ? "." : NSRegularExpression.escapedPattern(for: String($0)) }.joined() + "\\z"
        : query
      do { expression = try NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) }
      catch { throw NSError(domain: "FileSearch", code: 1, userInfo: [NSLocalizedDescriptionKey: NL("正则表达式无效")]) }
    }
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
        let matched: Bool
        if let expression {
          var found = false, timedOut = false
          let started = ProcessInfo.processInfo.systemUptime
          expression.enumerateMatches(in: entry.name, options: .reportProgress, range: NSRange(entry.name.startIndex..., in: entry.name)) { result, _, stop in
            if Task.isCancelled || ProcessInfo.processInfo.systemUptime - started > 0.05 {
              timedOut = true; stop.pointee = true
            } else if result != nil { found = true; stop.pointee = true }
          }
          try Task.checkCancellation()
          if timedOut { throw NSError(domain: "FileSearch", code: 2, userInfo: [NSLocalizedDescriptionKey: NL("搜索表达式过于复杂")]) }
          matched = found
        } else { matched = entry.name.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
        if matched { matches.append(entry) }
        if entry.isDirectory && !entry.isSymbolicLink && !entry.isPackage { queue.append(entry.url) }
        if visited >= 30_000 || matches.count >= 1_000 { break }
      }
    }
    return FileSearchResult(entries: matches, truncated: visited >= 30_000 || matches.count >= 1_000, skipped: skipped)
  }
}
