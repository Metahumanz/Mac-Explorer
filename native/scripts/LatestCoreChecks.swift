import Foundation

@main
enum LatestCoreChecks {
  static func main() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("native-latest-core-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    var checks = 0
    func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
      guard try condition() else { throw NSError(domain: "LatestCoreChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }; checks += 1
    }
    let folder = root.appendingPathComponent("项目"), alias = root.appendingPathComponent("alias"), file = root.appendingPathComponent("file.txt"), app = root.appendingPathComponent("Fake.app")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
    try Data("preserved".utf8).write(to: file)
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: folder)
    let candidates = [FinderFavorite(path: folder.path, name: "收藏名称"), FinderFavorite(path: alias.path, name: "Alias duplicate"), FinderFavorite(path: file.path, name: "File"), FinderFavorite(path: app.path, name: "App"), FinderFavorite(path: "relative", name: "Invalid"), FinderFavorite(path: root.appendingPathComponent("missing").path, name: "Missing")]
    let result = FinderFavoritesReader.filter(candidates)
    try expect(result.places.count == 1 && result.places[0].name == "收藏名称", "Finder deduplicates aliases and retains the first display name")
    try expect(result.skipped == 4, "Finder rejects files, packages, relative and missing locations")
    let suite = "native-latest-core.\(UUID().uuidString)", defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    var places = QuickAccessState(defaults: defaults)
    places.toggle("/Existing", defaultPaths: ["/Downloads"])
    places.toggle("/Downloads", defaultPaths: ["/Downloads"])
    let imported = [FinderFavorite(path: "/Downloads", name: "下载"), result.places[0], FinderFavorite(path: "/Cloud", name: "Cloud")]
    try expect(places.merge(imported, defaultPaths: ["/Downloads"], excludedPaths: ["/Cloud"]) == 2, "Import restores defaults and appends new items")
    try expect(places.visible(defaultPaths: ["/Downloads"]) == ["/Existing", "/Downloads", folder.standardizedFileURL.path], "Import preserves existing order")
    try expect(places.merge(imported, defaultPaths: ["/Downloads"], excludedPaths: ["/Cloud"]) == 0, "Repeated import adds no duplicates")
    places.save(to: defaults)
    try expect(QuickAccessState(defaults: defaults).importedNames[folder.standardizedFileURL.path] == "收藏名称", "Imported names survive reload")
    let windows = [NativeSavedWindow(locations: [folder.absoluteString, "explorer://trash", "https://example.com", "file://evil.example/etc/passwd", "explorer://unknown"], frame: "{{0, 0}, {1000, 700}}")]
    try NativeSessions.save(windows, to: defaults)
    try expect(NativeSessions.load(defaults).first?.locations == [folder.absoluteString, "explorer://trash"], "Session persistence rejects remote URLs and unknown virtual locations")
    defaults.set(Data("corrupt".utf8), forKey: "nativeWindows")
    try expect(NativeSessions.load(defaults).isEmpty, "Corrupt session data is ignored")
    NativeLanguage.load(from: URL(fileURLWithPath: CommandLine.arguments[1]))
    NativeLanguage.mode = "en"
    try expect(NL("从 Finder 导入收藏夹") == "Import Finder favorites", "English catalog is loaded")
    try expect(NL("已导入 {0} 项", "归档{1}.zip") == "Imported 归档{1}.zip items", "Interpolation preserves filenames containing placeholder syntax")
    let copied = FileActions.transfer([file], to: root, move: false)
    try expect(copied.errors.isEmpty && copied.succeeded.first?.lastPathComponent == "file - Copy.txt", "Generated copy names follow the interface language")
    NativeLanguage.mode = "zh-TW"
    try expect(NL("从 Finder 导入收藏夹") == "從 Finder 匯入喜好項目", "Traditional Chinese catalog is loaded")
    NativeLanguage.mode = "zh-CN"
    let literal = "含空格 $(touch forbidden); --literal"
    try expect(NativeCommand.run(executable: "/usr/bin/printf", arguments: ["%s", literal]).text == literal, "Native command arguments remain literal without a shell")
    do { _ = try NativeCommand.run(executable: "/usr/bin/false", arguments: []); throw CocoaError(.validationMissingMandatoryProperty) } catch let error as NativeCommandError { try expect(error.result.status != 0, "Command errors retain the actual exit status") }
    do { _ = try NativeCommand.run(executable: "/bin/sleep", arguments: ["3"], timeout: 0.1); throw CocoaError(.validationMissingMandatoryProperty) } catch { try expect((error as NSError).domain == "NativeCommand", "Native commands enforce deadlines") }
    do { _ = try NativeCommand.run(executable: "/usr/bin/head", arguments: ["-c", "4096", "/dev/zero"], limit: 128); throw CocoaError(.validationMissingMandatoryProperty) } catch { try expect((error as NSError).domain == "NativeCommand", "Native commands enforce output limits") }
    try expect(try String(contentsOf: file, encoding: .utf8) == "preserved", "All source fixture contents remain unchanged")
    print("LatestCoreChecks: \(checks) checks passed.")
  }
}
