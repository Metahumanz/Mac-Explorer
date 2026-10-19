import Foundation

public enum NativeLanguage {
  private static let lock = NSLock()
  private static var savedMode = "system"
  public static var mode: String {
    get { lock.lock(); defer { lock.unlock() }; return savedMode }
    set { lock.lock(); savedMode = ["system", "zh-CN", "zh-TW", "en"].contains(newValue) ? newValue : "system"; lock.unlock() }
  }
  public static var locale: String {
    let mode = Self.mode
    if mode != "system" { return mode }
    let preferred = Locale.preferredLanguages.first?.replacingOccurrences(of: "_", with: "-").lowercased() ?? "en"
    guard preferred.hasPrefix("zh") else { return "en" }
    return preferred.contains("hant") || preferred.split(separator: "-").contains(where: { ["tw", "hk", "mo"].contains(String($0)) }) ? "zh-TW" : "zh-CN"
  }
  public static var formatLocale: Locale { Locale(identifier: locale) }
  private static var dictionaries: [String: [String: String]] = [:]
  public static func load(from directory: URL) {
    for locale in ["en", "zh-TW"] {
      if let data = try? Data(contentsOf: directory.appendingPathComponent(locale + ".json")), let dictionary = try? JSONDecoder().decode([String: String].self, from: data) { lock.lock(); dictionaries[locale] = dictionary; lock.unlock() }
    }
  }
  public static func translate(_ key: String, _ values: [String]) -> String {
    let locale = Self.locale
    lock.lock(); let template = dictionaries[locale]?[key] ?? key; lock.unlock()
    let expression = try! NSRegularExpression(pattern: #"\{(\d+)\}"#)
    let value = NSMutableString(string: template)
    for match in expression.matches(in: template, range: NSRange(location: 0, length: (template as NSString).length)).reversed() {
      if let index = Int((template as NSString).substring(with: match.range(at: 1))), values.indices.contains(index) { value.replaceCharacters(in: match.range, with: values[index]) }
    }
    return value as String
  }
}
public func NL(_ key: String, _ values: Any...) -> String { NativeLanguage.translate(key, values.map { String(describing: $0) }) }
