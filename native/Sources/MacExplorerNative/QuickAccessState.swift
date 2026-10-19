import Foundation
#if canImport(ExplorerCore)
import ExplorerCore
#endif

struct QuickAccessState {
  var customPaths: [String]
  var excludedDefaults: Set<String>
  var order: [String]
  var importedNames: [String: String]

  init(defaults: UserDefaults) {
    importedNames = defaults.dictionary(forKey: "finderNames") as? [String: String] ?? [:]
    customPaths = Self.unique(defaults.stringArray(forKey: "pins") ?? [])
    excludedDefaults = Set(defaults.stringArray(forKey: "unpinnedDefaults") ?? [])
    order = Self.unique(defaults.stringArray(forKey: "placeOrder") ?? [])
  }
  func visible(defaultPaths: [String]) -> [String] {
    let defaults = Set(defaultPaths)
    let paths = Self.unique(defaultPaths.filter { !excludedDefaults.contains($0) } + customPaths.filter { !defaults.contains($0) })
    let available = Set(paths), ranked = order.filter { available.contains($0) }, ranks = Set(order)
    return ranked + paths.filter { !ranks.contains($0) }
  }
  mutating func toggle(_ path: String, defaultPaths: [String]) {
    let pinned = visible(defaultPaths: defaultPaths).contains(path)
    if defaultPaths.contains(path) {
      if pinned { excludedDefaults.insert(path) } else { excludedDefaults.remove(path) }
      customPaths.removeAll { $0 == path }
    } else if pinned { customPaths.removeAll { $0 == path } }
    else { customPaths.append(path) }
    if !pinned { order.removeAll { $0 == path } }
  }
  mutating func insert(_ paths: [String], at index: Int, defaultPaths: [String]) {
    let moved = Self.unique(paths); guard !moved.isEmpty else { return }
    let current = visible(defaultPaths: defaultPaths), insertion = min(current.count, max(0, index)), movedSet = Set(moved)
    customPaths = Self.unique(customPaths + moved.filter { !defaultPaths.contains($0) })
    excludedDefaults.subtract(movedSet)
    order = current.prefix(insertion).filter { !movedSet.contains($0) } + moved + current.dropFirst(insertion).filter { !movedSet.contains($0) }
  }
  @discardableResult
  mutating func merge(_ favorites: [FinderFavorite], defaultPaths: [String], excludedPaths: Set<String>) -> Int {
    let current = visible(defaultPaths: defaultPaths)
    var known = Set(current.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path })
    var incoming: [String] = []
    for favorite in favorites where !excludedPaths.contains(favorite.path) {
      let canonical = URL(fileURLWithPath: favorite.path).resolvingSymlinksInPath().path
      importedNames[favorite.path] = favorite.name
      if known.insert(canonical).inserted { incoming.append(favorite.path) }
    }
    customPaths = Self.unique(customPaths + incoming.filter { !defaultPaths.contains($0) })
    excludedDefaults.subtract(incoming)
    order = Self.unique(current + order + incoming)
    return incoming.count
  }
  func save(to defaults: UserDefaults) {
    defaults.set(importedNames, forKey: "finderNames")
    defaults.set(customPaths, forKey: "pins"); defaults.set(Array(excludedDefaults).sorted(), forKey: "unpinnedDefaults"); defaults.set(order, forKey: "placeOrder")
  }
  private static func unique(_ values: [String]) -> [String] {
    var seen = Set<String>()
    return values.filter { $0.hasPrefix("/") && !$0.contains("\0") && seen.insert($0).inserted }
  }
}
