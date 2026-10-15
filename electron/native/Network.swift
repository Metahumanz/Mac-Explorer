import AppKit
import NetFS

final class Discovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    let browser = NetServiceBrowser()
    var services: [String: NetService] = [:]
    var servers: [String: [String: String]] = [:]
    var failure: String?

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        let key = service.name + "." + service.domain
        services[key] = service
        service.delegate = self
        service.resolve(withTimeout: 2)
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        let key = service.name + "." + service.domain
        services.removeValue(forKey: key)?.stop()
        servers.removeValue(forKey: key)
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        failure = String(describing: errorDict)
    }
    func netServiceDidResolveAddress(_ service: NetService) {
        guard let host = service.hostName, service.port > 0 else { return }
        var address = URLComponents()
        address.scheme = "smb"
        address.host = host
        if service.port != 445 { address.port = service.port }
        guard let url = address.url else { return }
        servers[service.name + "." + service.domain] = ["name": service.name, "address": url.absoluteString]
    }
    func discover() throws -> [[String: String]] {
        browser.delegate = self
        browser.searchForServices(ofType: "_smb._tcp.", inDomain: "local.")
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 4))
        browser.stop()
        for service in services.values { service.stop() }
        if let failure = failure { throw NSError(domain: "MacExplorer.Network", code: 1, userInfo: [NSLocalizedDescriptionKey: failure]) }
        return servers.values.sorted { $0["name"]! < $1["name"]! }
    }
}

do {
    let args = CommandLine.arguments
    let result: Any
    if args.count == 2 && args[1] == "discover" {
        result = try Discovery().discover()
    } else if args.count == 3 && args[1] == "connect" {
        guard let parts = URLComponents(string: args[2]), parts.scheme == "smb", parts.host?.isEmpty == false,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              let url = parts.url else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(EINVAL)) }
        var mounts: Unmanaged<CFArray>?
        let status = NetFSMountURLSync(url as CFURL, nil, nil, nil, nil, nil, &mounts)
        let paths = mounts?.takeRetainedValue() as? [String] ?? []
        if status == -128 { result = NSNull() }
        else if status == 0 || (status == EEXIST && !paths.isEmpty) { result = paths }
        else { throw NSError(domain: status > 0 ? NSPOSIXErrorDomain : NSOSStatusErrorDomain, code: Int(status)) }
    } else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(EINVAL)) }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed]))
} catch {
    FileHandle.standardError.write(Data(error.localizedDescription.utf8))
    exit(1)
}
