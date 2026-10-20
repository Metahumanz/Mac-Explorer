# SMB 历史测试残留清理

日期：2026-10-20。4C 隔离体验期间，用户指出旧测试目录仍在且不能删除，并已授予应用权限。本次据此处理已确认由测试创建的残留；不是再次传输验收，也未改变 NAS 配置、挂载或应用业务源码。

## 最新核对

用户随后在树莓派自行执行精确删除命令。2026-10-20 权限提示修复期间，从 Mac 对原 35 个路径逐项只读复核，均已不存在；最后 5 个 NSSD 测试根已清理。NAS 本地备份目录仅包含在给用户的删除命令中，未从 NAS 本地独立核验。此前失败过程保留如下。

## 清单与当时实际结果

以 Phase 1 的 `phase1-smb-acceptance-20261020T064444Z/preserved-fixture-inventory.json` 精确路径清单为依据，共 35 个旧测试根。逐根核对设备、inode、出生秒、类型及内部条目；不按前缀扫描或递归删除共享。检查时 18 根已不存在，17 根仍在；所有剩余根及条目身份匹配，没有未知新增条目。

- 本地 `/private/tmp` 的 12 根已先备份数据和元数据清单，再逐项删除，最后仅移除空目录；独立读回确认不存在。
- NSSD 的 5 根仍在，内部剩 6 个 4096 字节的 `._` 测试元数据伴随文件（共 24 KiB）及其父目录。不能报告清理成功。
- NAS 文件实际内容备份失败：打开 `._` 文件读取时返回 `EACCES (13)`。后续单独执行定点 `unlink` 也返回 `EACCES (13)`；对只含已知伴随文件的目录发出 `rmdir` 则返回 `ENOTEMPTY (66)`。没有修改 ACL、权限、服务器配置，也未用全盘/共享递归删除绕过错误。
- NAS 当前属性为本用户、模式 0700、仅 hidden 标志；这些客户端属性不足以证明服务器实际允许读取、写入或删除。后续需要树莓派端核查，不能直接认定底层 NTFS 权限或某个 Samba 配置就是原因。

剩余根仅为：

```text
/Volumes/NSSD/MacExplorer-SMB-Test-FF2614B2-ABC5-4641-9B3B-9FF279D0BFB5-r1
/Volumes/NSSD/MacExplorer-SMB-Test-E99661FC-6A4F-4BF8-88EC-9A24A8EAB86E-r2
/Volumes/NSSD/MacExplorer-SMB-Test-911E6925-9CD4-4658-9252-B5B56DE357F7-r2
/Volumes/NSSD/MacExplorer-SMB-Test-4D8C8033-B9C8-4AEB-ADC8-14539A715DF6-r2
/Volumes/NSSD/MacExplorer-SMB-Test-0F5346C5-B0CF-45F5-A1DE-18F5243E1616-probe
```

## 权限提示与后续

`BrowserController.errorMessage` 当前把 Cocoa 读写无权限及 POSIX EACCES/EPERM 统一设置为 `needsFullDiskAccess`，并显示“前往设置”。因此该提示不能区分 macOS 隐私授权、SMB 访问限制和服务端权限。本次在应用之外同样复现文件读取和删除失败，不能继续把失败归因于用户未给应用授权；隔离版和日常版有不同 Bundle ID，但也不足以解释全部现象。

Samba 的 [vfs_fruit 文档](https://www.samba.org/samba/samba/docs/current/man-html/vfs_fruit.8.html) 说明 AppleDouble 访问可受服务端保护；这只是排查方向，尚未读取本机 NAS 配置确认。已向用户询问树莓派 SSH 地址或 NAS 终端操作方式，取得必要连接信息后继续按白名单处理，不索取密码、不自动更改整个共享权限。

证据与本地备份位于 `native/output/validation/fixture-cleanup-20261020T120443Z/`：`audit.json`、`cleanup-result.json`、`unlink-sidecars-result.json`、`rmdir-result.json`、`nas-cleanup-allowlist.json`、`final-readback.json` 和 `backup/`。最初清理日志中的 NAS PermissionError 发生在备份读取阶段，不能据该日志单独声称已尝试 unlink；真实 unlink 错误以后续专门日志为准。旧 Phase 1 清单和失败报告继续保留为历史证据。

用户随后选择自行 SSH 登录树莓派清理。已准备可粘贴的 `sudo python3` 白名单命令（本地存档 `fixture-cleanup-20261020T120443Z/nas-cleanup.py`）：通过 `testparm` 读取 NSSD 共享路径，无法识别时提示输入；先核对精确条目及 4096 字节 AppleDouble 头，全部内容备份到 NAS `/var/tmp/MacExplorer-cleanup-backup-*` 后，再逐文件 unlink、逐目录 rmdir。已用本地临时夹具验证正常清理、未知文件、非 AppleDouble 内容和符号链接 4 类结果；没有在真实 NAS 执行，实际结果等待用户反馈。

用户反馈已在树莓派执行命令，实际共享路径为 `/mnt/NSSD`，生成备份 `/var/tmp/MacExplorer-cleanup-backup-9g8vtaol` 后在 E99661FC 根的子目录 rmdir 返回 ENOTEMPTY。用户明确不需要保留测试残余备份。本机本轮生成的 `fixture-cleanup-20261020T120443Z/backup` 已删除；改为提供五个精确 UUID 根及上述精确 NAS 备份目录的直接删除命令，不使用前缀通配符。NAS 清理结果仍等待实际执行反馈，不能视为已清理成功。
