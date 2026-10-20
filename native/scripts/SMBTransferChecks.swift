import Foundation
import Darwin
import CryptoKit

private struct SMBFailure: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}
private struct SMBEntry: Codable {
  let relative: String
  let device: Int32
  let inode: UInt64
  let mode: UInt16
  let size: Int64
  let birthSeconds: Int
  let birthNanos: Int
  let modifiedSeconds: Int
  let modifiedNanos: Int
  let changedSeconds: Int
  let changedNanos: Int
  let sha256: String?
  var directory: Bool { mode_t(mode) & S_IFMT == S_IFDIR }
  func sameObject(_ other: Self, precision:Int=1) -> Bool { device == other.device && inode == other.inode && TransferMoment(timespec(tv_sec:birthSeconds,tv_nsec:birthNanos)).matches(TransferMoment(timespec(tv_sec:other.birthSeconds,tv_nsec:other.birthNanos)),precision:precision) }
  func json() throws -> [String: Any] { try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as! [String: Any] }
}

/// Explicitly opt-in integration checks. No NAS operation is part of check-core.py.
@main
private struct SMBTransferChecks {
  static func main() {
    do {
      let args = Array(CommandLine.arguments.dropFirst())
      func value(_ key: String) throws -> String {
        guard let index = args.firstIndex(of: key), args.indices.contains(index + 1) else { throw SMBFailure("Required: --execute --plan PLAN --round 1|2 --report REPORT [--local-dry-run]") }
        return args[index + 1]
      }
      guard args.contains("--execute"), let round = Int(try value("--round")), [1,2,3].contains(round) else { throw SMBFailure("Explicit --execute and round 1, 2 or 3 are required") }
      let plan = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: try value("--plan")))) as! [String: Any]
      guard let id = plan["id"] as? String, UUID(uuidString: id)?.uuidString == id,
            plan["maxCreatedFilesPerRound"] as? Int == 12, plan["maxLogicalBytesPerRound"] as? Int == 65_536 else { throw SMBFailure("Invalid bounded test plan") }
      let runner = try Runner(plan: plan, id: id, round: round, dryRun: args.contains("--local-dry-run"), output: URL(fileURLWithPath: try value("--report")))
      try runner.run()
    } catch { fputs("SMB checks stopped: \(error.localizedDescription)\n", stderr); exit(1) }
  }
}

private final class Runner {
  let fm = FileManager.default
  let id: String, round: Int, dryRun: Bool, output: URL
  var roots: [String: URL] = [:], rootIdentities: [String: SMBEntry] = [:]
  var known = Set<String>(), createdFiles = 0, createdBytes = 0
  var cases: [[String: Any]] = [], setup: [[String: Any]] = [], problems: [[String: Any]] = []
  var cleaned: [String] = [], dryBase: URL?
  var expected: [String: SMBEntry] = [:]
  var report: [String: Any] = [:]
  var metadataCompanions: [[String: Any]] = []
  init(plan: [String: Any], id: String, round: Int, dryRun: Bool, output: URL) throws {
    self.id = id; self.round = round; self.dryRun = dryRun; self.output = output
    guard let rounds = plan["rounds"] as? [[String: Any]], let selected = rounds.first(where: { $0["round"] as? Int == round }),
          let planned = selected["roots"] as? [String: String] else { throw SMBFailure("Missing round roots") }
    let name = "MacExplorer-SMB-Test-" + id + "-r" + String(round)
    let parents = ["local":"/private/tmp", "passport":"/Volumes/passport", "NSSD":"/Volumes/NSSD"]
    for (key,parent) in parents {
      guard planned[key] == parent + "/" + name else { throw SMBFailure("Plan root escaped its exact approved parent") }
      roots[key] = URL(fileURLWithPath: planned[key]!)
    }
    if dryRun {
      let base = URL(fileURLWithPath: "/private/tmp/SMB-DryRun-" + UUID().uuidString)
      guard mkdir(base.path,0o700)==0 else { throw posix() }; dryBase = base
      for key in parents.keys { roots[key] = base.appendingPathComponent(key+"-"+name) }
    }
    report = ["id":id,"round":round,"dryRun":dryRun,"startedUTC":ISO8601DateFormatter().string(from:Date()),"timezone":TimeZone.current.identifier,"roots":roots.mapValues(\.path),"maxCreatedFiles":12,"maxLogicalBytes":65_536]
  }
  func posix() -> NSError { NSError(domain:NSPOSIXErrorDomain,code:Int(errno)) }
  func writeReport(_ status:String, error:String?=nil) throws {
    report["status"]=status;report["cases"]=cases;report["setup"]=setup;report["problems"]=problems
    report["rootIdentities"]=try rootIdentities.mapValues{try $0.json()}
    report["createdFilesBudget"]=createdFiles;report["createdLogicalBytesBudget"]=createdBytes;report["cleanedRoots"]=cleaned
    report["metadataCompanions"]=metadataCompanions
    if let error { report["error"]=error }
    try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:output,options:.atomic)
  }
  func require(_ condition:Bool,_ message:String) throws { if !condition {throw SMBFailure(message)} }
  func filesystem(_ path:URL) throws -> String {
    var s=statfs();guard statfs(path.path,&s)==0 else {throw posix()}
    return withUnsafePointer(to:&s.f_fstypename) {$0.withMemoryRebound(to:CChar.self,capacity:16){String(cString:$0)}}
  }
  func bounded(_ path:URL) throws {
    guard path.isFileURL, let root=roots.values.first(where:{path.path == $0.path || path.path.hasPrefix($0.path+"/")}) else {throw SMBFailure("Refusing a path outside the dedicated fixture roots")}
    if let expected=rootIdentities[root.path] {
      var info=stat();guard lstat(root.path,&info)==0, info.st_mode & S_IFMT == S_IFDIR, info.st_dev==expected.device, info.st_ino==expected.inode else {throw SMBFailure("Dedicated root was replaced; refusing fixture access")}
    }
  }
  func entry(_ path:URL, relative:String) throws -> SMBEntry {
    try bounded(path)
    var s=stat();guard lstat(path.path,&s)==0 else {throw posix()}
    let kind=s.st_mode & S_IFMT
    try require(kind == S_IFREG || kind == S_IFDIR,"Unexpected link or special node inside fixture; preserving it")
    var hash:String?
    if kind == S_IFREG {
      try require(s.st_size==0 || s.st_size==2,"Unexpected fixture size; refusing to read or remove it")
      let data=try Data(contentsOf:path);hash=SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()
    }
    return SMBEntry(relative:relative,device:s.st_dev,inode:s.st_ino,mode:s.st_mode,size:s.st_size,birthSeconds:s.st_birthtimespec.tv_sec,birthNanos:s.st_birthtimespec.tv_nsec,modifiedSeconds:s.st_mtimespec.tv_sec,modifiedNanos:s.st_mtimespec.tv_nsec,changedSeconds:s.st_ctimespec.tv_sec,changedNanos:s.st_ctimespec.tv_nsec,sha256:hash)
  }
  func snapshot(_ path:URL) throws -> [SMBEntry] {
    let root=try entry(path,relative:"")
    var result=[root]
    func walk(_ directory:URL,_ prefix:String) throws {
      for name in try fm.contentsOfDirectory(atPath:directory.path).sorted() {
        let fd=open(directory.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
        guard fd>=0 else {throw posix()}
        let metadata:Bool
        do {metadata=try AppleDoubleCompanion.isMetadata(name,in:fd);close(fd)} catch {close(fd);throw error}
        if metadata {
          let path=directory.appendingPathComponent(name);var s=stat();guard lstat(path.path,&s)==0 else {throw posix()}
          metadataCompanions.append(["path":path.path,"size":s.st_size,"device":s.st_dev,"inode":s.st_ino]);continue
        }
        let path=directory.appendingPathComponent(name), rel=prefix.isEmpty ? name : prefix+"/"+name
        let value=try entry(path,relative:rel);result.append(value)
        if value.directory {try walk(path,rel)}
      }
    }
    if root.directory {try walk(path,"")};return result
  }
  func exists(_ path:URL) -> Bool {var s=stat();return lstat(path.path,&s)==0}
  func directory(_ path:URL) throws {
    try bounded(path)
    if exists(path) {try require(known.contains(path.path),"Refusing an unowned directory");return}
    guard mkdir(path.path,0o700)==0 else {throw posix()};known.insert(path.path)
  }
  func dates(_ path:URL,index:Int) throws {
    let fd=open(path.path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);guard fd>=0 else {throw posix()};defer{close(fd)}
    var a=attrlist();a.bitmapcount=UInt16(ATTR_BIT_MAP_COUNT);a.commonattr=attrgroup_t(ATTR_CMN_CRTIME|ATTR_CMN_MODTIME)
    var values=[timespec(tv_sec:1_600_000_000+index,tv_nsec:123_456_700),timespec(tv_sec:1_600_000_100+index,tv_nsec:987_654_300)]
    let result=values.withUnsafeMutableBytes{fsetattrlist(fd,&a,$0.baseAddress,$0.count,0)}
    let code=result==0 ? 0 : errno
    let observed=try entry(path,relative:"");expected[path.path]=observed
    setup.append(["path":path.path,"dateSetterReturn":result,"errno":code,"observed":try observed.json()])
  }
  func reserve(files:Int,bytes:Int) throws {
    try require(createdFiles+files<=12 && createdBytes+bytes<=65_536,"Fixture budget exceeded")
    createdFiles+=files;createdBytes+=bytes
  }
  func file(_ path:URL,data:Data,index:Int) throws {
    try bounded(path);try reserve(files:1,bytes:data.count)
    let fd=open(path.path,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600);guard fd>=0 else {throw posix()}
    let count=data.withUnsafeBytes{Darwin.write(fd,$0.baseAddress,$0.count)};let code=errno;close(fd)
    guard count==data.count else {throw NSError(domain:NSPOSIXErrorDomain,code:Int(code))}
    known.insert(path.path);try dates(path,index:index)
  }
  func verify(_ before:[SMBEntry],_ after:[SMBEntry],exact:Bool) throws {
    try require(before.count==after.count,"Destination tree differs")
    for (a,b) in zip(before,after) {
      try require(a.relative==b.relative && a.directory==b.directory && (a.directory || a.size==b.size && a.sha256==b.sha256),"Destination data or layout differs")
      let unit=exact ? 1 : 100
      try require(a.birthSeconds==b.birthSeconds && a.birthNanos/unit==b.birthNanos/unit && a.modifiedSeconds==b.modifiedSeconds && a.modifiedNanos/unit==b.modifiedNanos/unit,"Birth/modified timestamps differ")
    }
  }
  @discardableResult
  func transfer(_ name:String,_ source:URL,_ target:URL,move:Bool,sameShare:Bool=false,collision:Bool=false,propertySkip:Bool=false,allowProvenanceLoss:Bool=true) throws -> URL {
    try bounded(source);try directory(target)
    let destination=target.appendingPathComponent(source.lastPathComponent),before=try snapshot(source)
    let oldTarget=exists(destination) ? try snapshot(destination) : []
    let regular=before.filter{!$0.directory};let count=regular.count, bytes=regular.reduce(0){$0+Int($1.size)}
    if !collision {try reserve(files:count,bytes:bytes)}
    var acceptedPropertyLoss=false
    var trace:[String]=[]
    let control=FileTransferControl(onProblem:{[self] problem in
      let accept=allowProvenanceLoss && !propertySkip && problem.propertyLoss && problem.message.contains("com.apple.provenance")
      if accept {acceptedPropertyLoss=true}
      problems.append(["case":name,"source":problem.source.path,"destination":problem.destination.path,"propertyLoss":problem.propertyLoss,"message":problem.message,"decision":accept ? "continueWithoutProperties" : "skip"]);return accept ? .continueWithoutProperties : .skip
    })
    var hooks=TransferHooks();hooks.control=control;hooks.checkpoint={point,_,_ in trace.append(String(describing:point))}
    let result=FileActions.transfer([source],to:target,move:move,hooks:hooks)
    let after=exists(destination) ? try snapshot(destination) : []
    let remaining=exists(source) ? try snapshot(source) : []
    var record:[String:Any]=["name":name,"source":source.path,"destination":destination.path,"move":move,"collision":collision,"before":try before.map{try $0.json()},"after":try after.map{try $0.json()},"sourceAfter":try remaining.map{try $0.json()},"errors":result.errors,"succeeded":result.succeeded.map(\.path),"transfers":result.transfers.map{["outcome":$0.outcome.rawValue,"method":$0.method.rawValue,"contentVerified":$0.contentVerified,"datesVerified":$0.datesVerified,"recoveryLocations":$0.recoveryLocations.map(\.path),"message":$0.message ?? ""]}]
    do {
      record["checkpoints"]=trace
      record["diagnostics"]=result.transfers.map{$0.diagnostic ?? ""}
      if propertySkip && result.succeeded.isEmpty {
        try require(result.succeeded.isEmpty && !result.errors.isEmpty && exists(source) && !exists(destination),"Property-loss skip did not retain source and clean destination")
        try verify(before,remaining,exact:true)
        record["propertyRejectionObserved"]=true
      } else if collision {
        try require(result.succeeded.isEmpty && !result.errors.isEmpty && exists(source),"Collision was not rejected")
        try verify(before,remaining,exact:true);try verify(oldTarget,after,exact:true)
      } else {
        try require((result.errors.isEmpty || acceptedPropertyLoss && result.errors.count==1) && result.succeeded.map{$0.resolvingSymlinksInPath().path}==[destination.resolvingSymlinksInPath().path] && result.transfers.count==1,"Transfer did not complete with its explicit property decision")
        record["acceptedProvenanceLoss"]=acceptedPropertyLoss
        if propertySkip {record["propertyRejectionObserved"]=false}
        let method=result.transfers[0].method
        if sameShare {try require(method == .rename || method == .systemCopy && result.transfers[0].datesVerified,"Same-share move did not use rename or verified compatibility copy")}
        else if move && !dryRun {try require(method == .systemCopy,"Cross-filesystem move did not use the real copy branch")}
        try verify(before,after,exact:method == .rename || dryRun)
        try require(move ? !exists(source) : exists(source),"Source existence does not match completion")
        if !move {try verify(before,remaining,exact:true)}
        for value in after {
          let path=value.relative.isEmpty ? destination.path : destination.appendingPathComponent(value.relative).path
          known.insert(path);expected[path]=value
        }
      }
      record["passed"]=true;cases.append(record);try writeReport("running")
      print("PASS: \(name)")
      return destination
    } catch {
      record["passed"]=false;record["assertion"]=error.localizedDescription;cases.append(record);try writeReport("failed",error:error.localizedDescription);throw error
    }
  }
  func cleanup(_ root:URL) throws {
    guard let expectedRoot=rootIdentities[root.path] else {throw SMBFailure("Root ownership missing")}
    let all=try snapshot(root)
    let network=try filesystem(root)=="smbfs"
    try require(expectedRoot.sameObject(all[0],precision:network ? 100 : 1),"Root identity changed; preserving it")
    for value in all {
      let path=value.relative.isEmpty ? root : root.appendingPathComponent(value.relative)
      try require(known.contains(path.path),"Unknown fixture child; preserving root")
    }
    for value in all.reversed() {
      let path=value.relative.isEmpty ? root : root.appendingPathComponent(value.relative)
      let current=try entry(path,relative:value.relative)
      try require(value.sameObject(current,precision:network ? 100 : 1) && (value.directory || value.sha256==current.sha256 && value.modifiedSeconds==current.modifiedSeconds && value.modifiedNanos==current.modifiedNanos && (network || value.changedSeconds==current.changedSeconds && value.changedNanos==current.changedNanos)),"Fixture changed during cleanup; preserving it")
      let parent=path.deletingLastPathComponent(),fd=open(parent.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
      guard fd>=0 else {throw posix()};defer{close(fd)}
      let companion=try AppleDoubleCompanion.stamp(in:fd,primary:path.lastPathComponent)
      guard unlinkat(fd,path.lastPathComponent,value.directory ? AT_REMOVEDIR : 0)==0 else {throw posix()}
      try AppleDoubleCompanion.remove(in:fd,primary:path.lastPathComponent,expected:companion)
    }
    cleaned.append(root.path);try writeReport("cleaning")
  }
  func run() throws {
    do {
      var mounts:[[String:Any]]=[]
      for key in ["local","passport","NSSD"] {
        let path=roots[key]!,parent=path.deletingLastPathComponent(),fs=try filesystem(parent)
        if !dryRun && key != "local" {try require(fs=="smbfs","Share is not mounted as SMB; refusing writes")}
        var space=statfs();guard statfs(parent.path,&space)==0 else {throw posix()}
        try require(UInt64(space.f_bavail)*UInt64(space.f_bsize)>=64*1024*1024,"Insufficient free space for bounded test")
        mounts.append(["role":key,"mountpoint":parent.path,"filesystem":fs,"availableBytes":UInt64(space.f_bavail)*UInt64(space.f_bsize)])
        try require(!exists(path),"Fixture root already exists; refusing adoption")
        try require(!exists(parent.appendingPathComponent("._"+path.lastPathComponent)),"Fixture root has an existing metadata companion; refusing adoption")
        guard mkdir(path.path,0o700)==0 else {throw posix()};known.insert(path.path);rootIdentities[path.path]=try entry(path,relative:"")
      }
      report["mounts"]=mounts;try writeReport("running")
      let local=roots["local"]!,p=roots["passport"]!,n=roots["NSSD"]!
      if round==1 {
        let a=local.appendingPathComponent("本地 2字节.txt"),b=p.appendingPathComponent("Pseed 2字节.txt"),c=n.appendingPathComponent("Nseed 2字节.txt")
        try file(a,data:Data("OK".utf8),index:1);try file(b,data:Data("OK".utf8),index:2);try file(c,data:Data("OK".utf8),index:3)
        let ap=try transfer("local → passport copy",a,p.appendingPathComponent("from-local-copy"),move:false)
        let an=try transfer("local → NSSD copy",a,n.appendingPathComponent("from-local-copy"),move:false)
        try transfer("NSSD → local cut",c,local.appendingPathComponent("from-NSSD-move"),move:true)
        let bn=try transfer("passport → NSSD cut",b,n.appendingPathComponent("from-passport-move"),move:true)
        let bp=try transfer("NSSD → passport cut",bn,p.appendingPathComponent("from-NSSD-move"),move:true)
        try transfer("passport same-share move",ap,p.appendingPathComponent("same-share"),move:true,sameShare:true)
        try transfer("NSSD same-share move",an,n.appendingPathComponent("same-share"),move:true,sameShare:true)
        let collision=n.appendingPathComponent("collision");try directory(collision);try file(collision.appendingPathComponent(bp.lastPathComponent),data:Data("NO".utf8),index:4)
        try transfer("existing target is not overwritten",bp,collision,move:false,collision:true)
        try transfer("local → passport cut",a,p.appendingPathComponent("from-local-move"),move:true)
      } else if round==2 {
        let tree=local.appendingPathComponent("目录 测试"),nested=tree.appendingPathComponent("子目录")
        try directory(tree);try directory(nested)
        try file(tree.appendingPathComponent("空文件.txt"),data:Data(),index:10)
        try file(nested.appendingPathComponent("中文 空格.txt"),data:Data("OK".utf8),index:11)
        try dates(nested,index:12);try dates(tree,index:13)
        let a=try transfer("tree local → NSSD cut",tree,n.appendingPathComponent("step-1"),move:true)
        let b=try transfer("tree NSSD → passport cut",a,p.appendingPathComponent("step-2"),move:true)
        let c=try transfer("tree passport → local cut",b,local.appendingPathComponent("step-3"),move:true)
        let d=try transfer("tree local → passport cut",c,p.appendingPathComponent("step-4"),move:true)
        try transfer("tree passport → NSSD cut",d,n.appendingPathComponent("step-5"),move:true)
      } else {
        let b=p.appendingPathComponent("Pseed 2字节.txt"),c=n.appendingPathComponent("Nseed 2字节.txt")
        try file(b,data:Data("OK".utf8),index:21);try file(c,data:Data("OK".utf8),index:22)
        if !dryRun {
          let localSeed=local.appendingPathComponent("属性跳过.txt")
          try file(localSeed,data:Data("OK".utf8),index:23)
          try transfer("NSSD provenance rejection → Skip keeps source",localSeed,n.appendingPathComponent("property-skip"),move:true,propertySkip:true,allowProvenanceLoss:false)
        }
        try transfer("passport → local copy",b,local.appendingPathComponent("from-passport-copy"),move:false)
        try transfer("NSSD → local copy",c,local.appendingPathComponent("from-NSSD-copy"),move:false)
      }
      Thread.sleep(forTimeInterval:2)
      var delayed:[[String:Any]]=[]
      for root in roots.values {
        let entries=try snapshot(root)
        for value in entries {
          let path=value.relative.isEmpty ? root : root.appendingPathComponent(value.relative)
          try require(known.contains(path.path),"Unexpected late fixture child")
          if let prior=expected[path.path] {
            let unit = try filesystem(path)=="apfs" ? 1 : 100
            try require(prior.sha256==value.sha256 && prior.birthSeconds==value.birthSeconds && prior.birthNanos/unit==value.birthNanos/unit && prior.modifiedSeconds==value.modifiedSeconds && prior.modifiedNanos/unit==value.modifiedNanos/unit,"Delayed readback differs from the recorded fixture dates/content")
          }
        }
        delayed.append(["root":root.path,"entries":try entries.map{try $0.json()}])
      }
      report["delayedReadback"]=delayed;try writeReport("verified")
      for key in ["passport","NSSD","local"] {try cleanup(roots[key]!)}
      if let dryBase {guard rmdir(dryBase.path)==0 else {throw posix()}}
      try writeReport("passed");print("Round \(round) passed: \(cases.count) cases, \(createdFiles) fixture-file instances, \(createdBytes) logical bytes; exact roots cleaned.")
    } catch {try? writeReport("failed",error:error.localizedDescription);throw error}
  }
}
