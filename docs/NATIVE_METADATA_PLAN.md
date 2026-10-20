# Mac Explorer Fork：原生版开发与验收计划

更新日期：2026-10-19。本文是本 Fork 当前执行计划；用户需求、旧版问题截图记录和 NAS 安全约束见 [交接文档](../CODEX_HANDOFF_Mac-Explorer.md)。构建说明以 [原生 README](../native/README.md) 为准。

## 当前决定与范围

用户已确认跟随上游 Swift/AppKit 原生实现，本机日常应用也已迁移到原生版；后续开发仍通过隔离构建和临时夹具验证。用户随后已授权并执行 Phase 0.5：隔离包构建和核心检查通过，初次 UI smoke 两次在双指前进断言失败；后续完成局部视口宽度修正及回归，最终完整 UI smoke 352 项通过。未修改文件操作或安装替换。用户自行完成的安装迁移不计作本会话验收。

- Phase 0 已完成；Phase 0.5 构建、包校验、启动、核心及完整 UI 自动检查完成，体验应用已按用户要求关闭。实际结果见 [Phase 0.5 验证记录](PHASE_0_5_VALIDATION.md)。
- 不同时维护 Electron 功能，不把切换到原生版称为 NAS 日期问题已修复。
- 保持 Windows Explorer 风格和现有功能；原生控件与 Electron 的实际差异需在体验中记录。
- 本次 Phase 0.5 提交不实施后续文件操作业务；不操作真实 NAS 文件、不修改系统默认项。
- Phase 1 后续默认策略需结合本项目日期保留目标和实际文件系统能力确定。

## 仓库基线与当前安装状态

| 项目 | 核实结果 |
| --- | --- |
| 审计提交 | `779cbd8b1cdf1c537bf3cfd9248f132222221886` |
| 功能分支 | `feat/metadata-safe-file-operations` |
| Fork | `origin` → `Metahumanz/Mac-Explorer` |
| 上游 | `upstream` → `qixiaoyu27/Mac-Explorer` |
| 上游差异 | Phase 0 只读远程查询时，上游 `main` 与审计提交相同；后续工作需重新核对 |
| 原生版本 | `native/VERSION` 为 `1.1.0` |
| 当前已安装版本 | 2026-10-19 本轮只读核实 `/Applications/Mac Explorer.app`：原生 `1.1.0`，Bundle ID `local.macexplorer.native-prototype`，可执行文件 `MacExplorerNative` |
| Phase 0 当时安装版本 | Electron `0.1.61`，Bundle ID `local.macexplorer.desktop`；已被用户迁移替换，保留为历史审计记录 |
| 开发验证包 | `native/output/validation/Mac Explorer.app`，独立 Bundle ID `local.macexplorer.native-validation`；本轮已构建、签名核对并打开本地临时夹具 |
| 历史基线 | 上游 `v0.1.61` 指向 `4a02d4c`，`v1.1.0` 指向 `6731fc7` |

`main` 已转为原生应用；保留的 Electron 目录不代表两套界面同时运行。`native/scripts/build.py` 仍复用 `electron/native/FileIcon.swift` 与 `electron/templates/`，不得为“清理仓库”而删除。`native/output/` 和 `native/.build/` 已被忽略，不提交生成产物。上游迁移报告保留为历史记录，不改写其测试结论，也不将其计为本 Fork 新的验收证据。

## Phase 0 审计记录

### 原生调用链

1. `BrowserController.copySelection(cut:)` 将文件 URL 与剪切标记写入 `NSPasteboard`，剪切动作本身不移动文件。
2. 快捷键、工具栏、右键粘贴及“将项目移到这里”汇入 `pasteFiles()`。
3. 列表、图标、标签页及侧栏文件拖入汇入 `FileActions.transfer`；Option 或来源不支持移动时走复制。
4. `transfer` 验证来源、目标目录、同目录及后代关系，按项目执行；同目录移动为空操作，复制生成副本名称。
5. `moveExclusively` 先调用 `renamex_np(RENAME_EXCL)`，成功则返回；`EXDEV`、`ENOTSUP`、`ENOSYS` 时回退到 `FileManager.moveItem`。`ENOTSUP` 不等同于跨卷。
6. 普通复制通过 `copyExclusively` 调用 `FileManager.copyItem`。
7. `runAsyncOperation` 汇总成功、错误和撤销记录；粘贴只移除剪贴板中的完成项，失败项保留；随后刷新列表。
8. `FileActions.undo` 和 `TrashStore.restore` 也使用同一移动底层，必须纳入回归。拖出至 Finder 后由接收方处理的移动不完全受本应用控制。

主要位置：`native/Sources/ExplorerCore/FileActions.swift`、`TrashStore.swift` 和 `native/Sources/MacExplorerNative/BrowserController.swift`。

### 历史 Electron 链路

`src/App.tsx` 剪切/复制 → preload → `clipboard-set`；粘贴 → `paste` IPC → `transferEntries` → `/bin/mv -n`。文件拖放通过 `move-to` 汇入同一传输函数；普通复制调用 `fs.cp(... preserveTimestamps: true)`，撤销移动复用 `moveNoReplace`。

当前仓库 `electron/files.ts` 与 `4a02d4c` 没有差异，可以用于解释历史 Electron 版的实现；不代表当前已安装原生版。未来业务修改以原生路径为目标。

### 根因与证据边界

| 判断 | 证据和限制 |
| --- | --- |
| 已确认的设计缺口 | 两版没有在跨卷删源前，设置独立的内容及创建/修改日期读回验证关卡；系统调用返回后便登记完成 |
| 主要排查方向 | 系统跨卷复制/删除过程的元数据处理，以及 macOS SMB 客户端、Samba、NTFS 驱动/挂载的元数据映射 |
| 创建日期 | 旧版 Node 复制选项没有显式恢复 birth time；原生版也没有自己的恢复/验证步骤。不能据此断言底层系统一定不保留 |
| 修改日期 | macOS `mv` 手册说明跨文件系统有保留属性的复制语义，不能仅因代码未显式设置日期就断言修改时间必然变化 |
| 用户截图 | 目标截图仍显示“正在粘贴”；必须等待结束后重新读取，不能把当时显示值当作最终结果 |
| 属性缓存 | Electron 属性窗口打开时请求一次；原生属性日期来自列表条目快照，后台大小统计不重新读取日期 |
| 服务器能力 | 未核实用户 Samba 版本、配置、NTFS 驱动及挂载选项；不得把推测写成服务端缺陷或要求用户默认改服务器 |

可行 API 为 Foundation `setAttributes` 的 `.creationDate` / `.modificationDate`；需要更低层控制时评估 `setattrlist` 的 `ATTR_CMN_CRTIME`、`ATTR_CMN_MODTIME` 和 `FSOPT_NOFOLLOW`。这些是候选实现，必须验证目标卷支持、链接语义、精度及重新读取结果。

参考：[Apple 属性设置](https://developer.apple.com/documentation/foundation/filemanager/setattributes(_:ofitematpath:))、[Apple setattrlist](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setattrlist.2.html)、[Node 22.12 复制实现](https://github.com/nodejs/node/blob/v22.12.0/lib/internal/fs/cp/cp.js)、[Samba 创建时间扩展属性说明](https://rzip.samba.org/samba/docs/4.15/man-html/smb.conf.5.html)。官方 API 或文档不构成用户 NAS 的实测保证。

### 功能现状与风险

- `FileEntry.created`、`modified` 和 `DirectoryReader` 的日期读取已存在；侧栏和属性窗口已有创建日期。
- `EntrySort` 只有 `name / modified / size / kind`。详细表格、菜单、设置均缺创建日期；列宽和隐藏规则包含四列索引假设。
- 原生磁盘卡片已依据 `volume.local` 显示“本地磁盘”或“网络位置”；旧版固定显示“本地磁盘”的缺陷不能直接套到原生版。
- 网络属性缺失时默认本地，容量缺失时变为 `0`；容量条虽已有除零/比例保护，未知值仍可能误导。
- 已有碰撞、后代路径、符号链接、部分失败和撤销身份保护应保留。
- 跨卷部分目标、元数据失败及删源失败缺少独立恢复状态；并发变化、断连、退出/崩溃时不能宣称原子或绝不丢数据。
- 原生撤销身份包含出生时间；未来需在元数据恢复后生成完成记录，避免操作使自己的记录失效。

### Phase 0 当时运行的检查

Phase 0 执行并通过：

```sh
python3 -I native/scripts/check-core.py CoreChecks FileActionChecks PropertiesChecks NetworkChecks
```

首次编译因默认缓存目录权限失败；将 `CLANG_MODULE_CACHE_PATH` 和 `SWIFT_MODULECACHE_PATH` 指向 `/private/tmp` 后同一检查通过。编译出现既有弃用/捕获警告，未修改源码。

这些检查使用临时写入夹具；`NetworkChecks` 另只读枚举挂载卷属性，未连接真实 SMB、推出卷或操作 NAS 文件。Phase 0 当时没有构建/启动应用、运行完整 UI smoke、执行 XCTest 或运行 Electron 测试。Phase 0.5 的构建和验证结果另见验证记录；旧版依赖未安装。

既有文件操作检查覆盖内容、碰撞、递归、链接、部分失败和撤销；缺少真实跨卷和传输后日期验证。原生剪贴板 UI 检查源码覆盖跨窗口部分成功/失败项保留，Phase 0 未运行；Phase 0.5 初次因早期失败未执行到，后续完整 smoke 已执行通过。上游历史通过数量不作为本轮通过数量。

## Phase 0.5：原生隔离构建、验证与体验

目标：在修改业务代码前，用独立 validation 包验证当前原生源码，并对照日常已安装原生版进行本地体验。Electron 0.1.61 仅作历史问题参考，不再把迁移安装作为待办。以下是执行流程；本轮结果以 [Phase 0.5 验证记录](PHASE_0_5_VALIDATION.md) 为准；初次失败已保留，局部修正后完整 UI 自动检查通过，不能扩大为真实触控板或 NAS 验收。

1. 核对工作区、工具链和审计基线。沿用功能分支，不自动拉取合并、不重置用户改动。
2. 按 `native/README.md` 执行 `python3 -I native/scripts/build.py --validation`。必要时将编译缓存指向允许写入的临时目录；环境限制和结果单独记录。
3. 校验生成包的 Bundle ID `local.macexplorer.native-validation`、版本、签名和实际产物路径 `native/output/validation/Mac Explorer.app`。日常已安装版 ID 为 `local.macexplorer.native-prototype`；不得仅凭相同应用名启动，须显式使用 validation 产物路径。不安装到 Applications，不覆盖普通开发包或日常安装版。
4. 执行 `python3 -I native/scripts/smoke.py --validation --skip-build`，审阅本次新报告，区分失败、跳过和环境阻塞；夹具和模拟回收站限临时目录，自动检查使用独立偏好域与命名剪贴板。
5. 创建本地临时体验目录和少量可丢弃文件，用 validation 应用显式打开该目录，交给用户体验。手动体验使用 validation 应用自身偏好域；普通手动复制仍会使用系统剪贴板，不能宣称完全沙箱化。
6. 核对导航/标签、八种布局、窄窗口、侧栏/预览、属性、快捷键、设置及临时文件操作。关注当前缺少的创建日期列；“此电脑”如需查看只核对卷卡片，不进入真实共享做操作。
7. 不开启系统文件查看器、全局唤醒或升级安装，不挂载/断开真实共享，不操作真实回收站。体验结束后保留可供复查的构建及脱敏结果；只清理本次明确创建的临时夹具。

验收门槛：生成可识别的隔离包、记录自动检查结果、由用户反馈 validation 包的体验和原生功能基线是否可接受。构建失败不触发改业务代码；体验完成也不自动进入 Phase 1。用户安装版与日常数据保持原状。

## Phase 1：元数据与跨卷安全

后续在用户授权后实施，NAS 人工写入另行授权。

- 保留同卷排他重命名效率；跨卷采用先复制、恢复和读回日期、确认目标后清理来源的顺序。
- 不覆盖碰撞目标，失败优先保留来源；内容验证强度、日期精度兼容、失败副本恢复及剪贴板/撤销语义单独落实。
- 先补本地基线和故障注入检查，再调整 `ExplorerCore/FileActions.swift` 与必要元数据模块，最后接入 UI、撤销及回收站还原。
- 目录后序恢复日期，链接只处理自身；保持 Foundation 复制能力，明确 ACL、扩展属性、资源分支等边界。
- 本地验证不能代替真实 Samba/NTFS 验收，不把暂存目录和身份检查称为原子事务。

## Phase 2：创建日期列和排序

修改 `EntryQuery.swift`、`BrowserController.swift`、`ExplorerDialogs.swift` 和必要本地化资源。沿用已有日期读取及格式，补表头点击、升降序、排序菜单、默认视图及每文件夹覆盖；重构局部四列索引假设，保持窄窗口和窗格行为。不默认扩展为任意列配置系统。

测试补到 `CoreChecks.swift`、`EntryQueryTests.swift` 和原生视图/设置检查：日期缺失、相同日期、名称/路径决胜、目录优先、旧设置读取、保存/重启及跨窗口同步。不要清空用户已有布局与排序。

## Phase 3：网络卷和容量

以已有“网络位置”分类为起点，先验证，再决定是否调整为“网络驱动器”。主要涉及 `NativeNetwork.swift`、`ExplorerSpecialView.swift`、`NetworkChecks.swift`、本地化及 UI 检查。

区分属性未知、容量未知、真实零值和读取错误；保留容量条及剩余/总容量。覆盖本地/外置/网络、零容量、free > total、缺失值和断连模拟。真实共享标签可另做只读确认，不以标签正确推断传输安全。

## 后续测试矩阵与 NAS 门槛

| 场景 | 必须记录或断言 |
| --- | --- |
| APFS 同卷、同 share 移动 | 实际路径分支、内容和日期；保留重命名效率 |
| 模拟跨卷普通文件/目录 | 各文件哈希、清单、日期及目录最后日期；链接不跟随 |
| 同名/空间不足/只读/断连 | 不覆盖，验证前不删源；失败阶段与残留准确 |
| 元数据拒绝/读回不同 | 不误报日期保留；移动来源保留 |
| 来源或目标被改写/替换 | 拒绝不安全清理，错误与恢复位置明确 |
| 多项部分成功、撤销/还原 | 剪贴板仅消费完成项，失败可重试，反向操作同样保护 |
| 中文/空格、空文件、小文本 | 路径与内容正确，记录原始时间精度 |
| 设置与窗口 | 创建日期排序及布局兼容，既有操作入口一致 |
| 真实 SMB/NTFS | 两共享双向、APFS ↔ SMB 复制/移动，另行授权后以专用小夹具执行 |

NAS 计划上限：每轮最多 12 个文件、合计不超过 64 KiB，使用空文件、2 字节及 KB 级文本。执行前提供两个共享下的具体 UUID 测试目录、清单、清理方法与风险并等待授权。空间不足/断连优先注入模拟，不填满真实磁盘或主动断开用户连接。异常保留现场，不扫描或批量清理用户目录。

每次时间验收记录 source/target 的 birth time、mtime 原始数值、大小、哈希、来源存在状态、返回结果、时区、客户端和服务器能力；等待后台操作完成后，用新一次 `stat` 与重新打开的属性窗口交叉核对。精度容差须有实测依据，不只比较分钟显示，也不以立即读回推断服务器永久落盘。

## 待确认及后续交付

原生路线和 Phase 0.5 已确认并完成隔离自动验证。后续阶段以最新用户授权为准；真实 SMB/NTFS 日期、权限、断连和服务器落盘行为须单独取得 NAS 小夹具授权再验收。

每阶段交付修改摘要、实际运行的检查、失败/未运行项、残余风险与回退方式。当前不安装替换、不推送、不发布、不合并 main。Phase 4 扩展待前面稳定后另行立项。
