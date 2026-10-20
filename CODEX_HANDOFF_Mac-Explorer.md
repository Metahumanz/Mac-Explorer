# Mac Explorer Fork：改造初始化与 Codex 交接文档

> 文档日期：2026-10-20（4C 收尾及网络删除追加）
>
> 上游仓库：https://github.com/qixiaoyu27/Mac-Explorer
>
> 当前已安装版本：Swift/AppKit 原生版 `1.1.0`（本轮只读核实）
>
> 历史问题实测版本：Electron `v0.1.61`（日期变化证据，不能视为原生版复现）
>
> 后续开发基线：跟随上游 Swift/AppKit 原生版 `1.1.0`，审计提交 `779cbd8`
>
> 用途：Fork 后作为本地 Codex 的**背景、目标、约束与验收依据**。此文档不是要求 Codex 一次性实现所有功能。

## 当前决定与执行状态（2026-10-20 更新）

用户已确认：**跟随上游，本机日常应用已迁移到原生版；开发仍使用隔离构建与验证。随后已授权 Phase 0.5 隔离构建验证；实际结果见 [Phase 0.5 验证记录](docs/PHASE_0_5_VALIDATION.md)。**

- Phase 0 已完成；完整审计结论、开发顺序和验收门槛见 [原生版开发与验收计划](docs/NATIVE_METADATA_PLAN.md)。后续接手先读该计划，再参考本文的历史证据与约束。
- 当前功能分支为 `feat/metadata-safe-file-operations`，无需重新克隆或重新建分支；`origin` 指向自己的 Fork，`upstream` 已保留。
- 当前安装包已只读核实为原生 `1.1.0`：`/Applications/Mac Explorer.app`，Bundle ID `local.macexplorer.native-prototype`，可执行文件 `MacExplorerNative`。
- Phase 0.5 已构建并打开独立 validation 应用（Bundle ID `local.macexplorer.native-validation`）：包校验、启动检查及 548 项核心检查通过；初次 UI smoke 两次失败；随后修正两处视口宽度计算，完整 UI smoke 352 项通过。体验应用已按用户要求关闭，不替换日常安装版。
- Phase 0.5 已单独提交：`511f6af`，包含视口修正、对应 UI 检查及阶段文档，未推送。
- 用户授权进入 Phase 1，随后要求待审核行为全部参考 Windows 文件资源管理器；当前实现按 [Windows 行为基准](docs/WINDOWS_FILE_OPERATION_BASELINE.md) 修订，实际结果见 [Phase 1 验证记录](docs/PHASE_1_VALIDATION.md)。
- 默认多轮哈希、来源隐藏改名和阶段日志已删除；使用系统复制及进度/取消、错误选择和日期恢复读回。Phase 1 已完成本地提交收尾；Phase 2 已完成本地提交收尾；Phase 3 已完成本地提交收尾；用户随后授权先做 4A/4B，现已完成实现与隔离验收（核心 714、UI 442 通过另 1 SVN 跳过），已完成本地提交；见 [4A/4B 验证记录](docs/PHASE_4AB_VALIDATION.md)。4A/4B 提交为 `a0a248d`；用户随后授权 4C，现已实现现有五列配置并完成隔离验收（核心 728、UI 476 通过另 1 SVN 跳过），已完成本地提交收尾；见 [4C 记录](docs/PHASE_4C_VALIDATION.md)。不修改系统默认项。
- 用户随后授权 SMB 实测、提交兼容修复及 Phase 1 复验。实际路径为 `/Volumes/passport` 与 `/Volumes/NSSD`；仅公布的新 UUID 小夹具。首次失败及旧现场见 [历史实测记录](docs/SMB_VALIDATION.md)，最新源码、真实矩阵、完整回归及保留现场以 [SMB 专项复验](docs/SMB_PHASE1_REACCEPTANCE.md) 为准。没有恢复多轮内容哈希或覆盖重命名，没有更改日常安装版。
- 4C 体验期间用户要求处理旧测试残留：原 35 根及 23 个根伴随文件现已逐项只读核实不存在；本机新建清理备份也已删除。用户选择自行在树莓派执行精确清理命令，过程与结果见 [残留清理记录](docs/SMB_FIXTURE_CLEANUP.md)。
- 用户随后授权修复权限提示：共享 EACCES/EPERM 不再误导为未授予完全磁盘访问权限；保留原因、错误码、具体失败路径，删除全部失败保留选择和剪贴板。最新完整核心 728、UI 491 通过另 1 SVN 跳过；验收及计划收尾状态见 [权限修复记录](docs/PERMISSION_ERROR_VALIDATION.md)。4C 与本轮修复已提交 `96c79d5`。
- 既定功能计划已完成至 4C；用户追加授权网络驱动器删除对齐 Windows：网络项目每次确认永久删除，取消为默认焦点，本地继续回收站；错误不静默降级。实现及隔离验收完成（核心 750、UI 511 通过另 1 SVN 跳过），详见 [网络删除记录](docs/NETWORK_DELETE_VALIDATION.md)。真实 NAS 永久删除没有在本轮测试。
- `native/PARITY_AUDIT.md`、`native/SYNC_STATUS.md` 是上游迁移记录，其通过数量不算本 Fork 本轮验收结果。

## 1. 项目背景与总体目标

用户希望继续使用 `qixiaoyu27/Mac-Explorer` 的 Windows 11 风格界面，将其改造成适合 macOS 本地文件和局域网 NAS 日常管理的文件资源管理器，而不是更换成双栏管理器或重写项目。

用户当前使用 MacBook Air M2；NAS 为树莓派 4B，运行 Samba，连接两个 NTFS 磁盘，对外共享名称在 Mac 上显示为 **`Passport`**、**`NSSD`**。本轮核实实际挂载路径是 `/Volumes/passport`（小写）和 `/Volumes/NSSD`，可以在 Mac Explorer 的「此电脑」中显示容量和打开文件。

**核心诉求（按优先级）：**

1. **P0：文件操作的数据安全。** 特别是剪切/粘贴跨磁盘、跨 SMB 共享时，不得因失败、掉线、目标已存在、空间不足或元数据恢复失败而静默丢失原文件。
2. **P1：尽可能保留原文件的创建日期和修改日期。** 重点是跨 `Passport` ↔ `NSSD` 的剪切/移动，也应检查普通复制。无法保证时明确反馈，不得误称已经保留。
3. **P2：详细信息视图增加「创建日期」列及排序。** 原始需求在 Phase 2 已实现并本地提交：详情列、表头/菜单、默认/文件夹排序及重启恢复均已完成隔离验收，见 [验证记录](docs/PHASE_2_VALIDATION.md)。
4. **P2：核验网络磁盘识别与完善容量展示。** 历史 Electron 版将 SMB 盘标注为「本地磁盘」；原生版已在 Phase 3 补齐「网络驱动器 / 类型未知」及容量未知/不可用状态，已知容量条保留；两个真实共享卷根只读核对通过，见 [验证记录](docs/PHASE_3_VALIDATION.md)。
5. **P3：改善 SMB 日常体验。** 连接收藏/手动重连及状态恢复已按用户授权在 4A/4B 实施，隔离验收边界见专项记录；用户随后授权 4C，列配置已实现并完成隔离验收及本地提交收尾。

**不在本轮目标内：** 重写 UI 框架、整体换技术栈、Windows 盘符模拟、开发全功能传输队列或断点续传平台、云同步、增加不相关的文件管理功能、自动管理真实 NAS 数据。

## 2. 用户已经实测的缺陷与证据

在 Mac Explorer v0.1.61 中，用户测试了跨 SMB 共享剪切一个 `1.txt` 文件：

| 位置 | 文件 | 创建日期（应用属性页） | 修改日期（应用属性页） |
| --- | --- | --- | --- |
| 来源：`/Volumes/Passport/1.txt` | 2 字节 | 2026-10-19 15:47 | 2026-10-19 15:48 |
| 目标：`/Volumes/NSSD/sync/1.txt` | 2 字节 | 2026-10-19 15:49 | 2026-10-19 15:49 |

操作方式为 **剪切 → 在另一共享中粘贴**。用户观察到两个时间都变为迁移发生时的时间。第二张截图为来源属性，第三张截图为目标属性；**第三张截图底部仍显示「正在粘贴…」**，所以需要在操作全部完成后重新读取目标属性，并使用 macOS `stat` 交叉验证，不能仅凭截图认定最终时间戳。

另一个可见问题：「此电脑」里 `Macintosh HD`、`Passport`、`NSSD` 都写成了「本地磁盘」，尽管后两个通过网络挂载；已显示蓝色容量条与可用空间。截图当时：`Passport` 约 86.6 GB 可用（总 1,863 GB），`NSSD` 约 5 GB 可用（总 1,907.7 GB）。**NSSD 空间紧张：测试仅能使用小型、可丢弃的专用测试文件，严禁拷贝真实大文件。**

注意：这里的「创建日期」指文件系统元数据中的 creation/birth time（例如 Node `birthtimeMs`），**不是**照片 EXIF 拍摄时间、媒体元数据日期或 Git 时间戳。

### 本机复现与数据记录（仅用于专用测试文件）

```bash
# 从真实文件操作前请先新建隔离测试目录；不要拿用户现有数据直接试。
# macOS BSD stat：同时输出人类可读时间和 Unix 秒时间戳。
stat -f '%N | create=%SB | modify=%Sm | birth_epoch=%B | mtime_epoch=%m' \
  -t '%Y-%m-%d %H:%M:%S' \
  '/Volumes/passport/<测试目录>/<测试文件>'

stat -f '%N | create=%SB | modify=%Sm | birth_epoch=%B | mtime_epoch=%m' \
  -t '%Y-%m-%d %H:%M:%S' \
  '/Volumes/NSSD/<测试目录>/<测试文件>'

# 检查系统识别的网络挂载及可用容量
mount | rg '/Volumes/(passport|NSSD)'
df -h '/Volumes/passport' '/Volumes/NSSD'
```

不要提交服务器口令、SMB 用户名、私有 IP 或私人文件；测试输出可脱敏。

## 3. 当前实现与历史定位

当前主应用是 `native/` 下的 Swift/AppKit 原生版；`src/`、`electron/`、`shared/` 是保留的 Electron 实现及共享构建资源。**不再以 Electron IPC 和 `/bin/mv` 作为本轮开发目标。**

| 原生位置 | Phase 0 审计结果 |
| --- | --- |
| `native/Sources/MacExplorerNative/BrowserController.swift` | 剪切/复制写入 `NSPasteboard`，粘贴、移动到这里、列表/图标/侧栏/标签页拖入最终调用 `FileActions.transfer`；完成后更新撤销、剪贴板和列表。 |
| `native/Sources/ExplorerCore/FileActions.swift` | 移动先调用 `renamex_np(RENAME_EXCL)`；`EXDEV`、`ENOTSUP`、`ENOSYS` 时回退 `FileManager.moveItem`。普通复制调用 `copyItem`。没有独立的传输后内容与日期验证关卡。 |
| 同上及 `TrashStore.swift` | 撤销与回收站还原依赖相同移动底层；修改时需要一起回归，避免反向移动再次丢失日期。 |
| `FileEntry.swift`、`DirectoryReader.swift` | 已读取 `created` / `modified`，日期可以缺失；信息侧栏及属性窗口已有创建日期。 |
| `EntryQuery.swift`、`BrowserController.swift`、`ExplorerDialogs.swift` | Phase 2 已补齐创建日期排序、列表列和默认排序设置，并以列标识替代四列索引假设。 |
| `NativeNetwork.swift`、`ExplorerSpecialView.swift` | Phase 0 当时仅区分本地与网络，卡片显示“网络位置”；Phase 3 已补齐未知状态、网络驱动器标签、容量异常及只读挂载验证。NetFS 与 Bonjour 保留。 |
| `native/scripts/build.py` | 原生构建仍复用 `electron/templates/` 与 `electron/native/FileIcon.swift`，不能清理掉这些资源。 |

历史 Electron `v0.1.61` 的报告仍有效：`moveNoReplace` 使用 `/bin/mv -n`，普通复制使用带 `preserveTimestamps` 的 `fs.cp`，“此电脑”固定显示“本地磁盘”。这些用于解释历史 Electron 版的现象，不将它们当作当前已安装原生版的实测结论。

原生完整链路应审计和回归：**快捷键/工具栏/菜单 → 剪贴板 → 粘贴/移动到这里/拖入 → `FileActions.transfer` → 排他重命名或跨卷处理 → 撤销记录、失败信息、剪贴板剩余项、刷新 → 属性重新读取。** 拖出至 Finder 后由接收方执行的传输不能宣称受本应用完全控制。

## 4. 改造原则与安全边界

1. **先弄清真实行为，再编码。** 区分同卷 `rename` 与跨卷「复制 + 删除」，并查明原生 `renamex_np` / `FileManager.moveItem` / `copyItem` 在 APFS、SMB/NTFS 组合下的实际元数据行为；不要凭经验假设 Linux `mv` 或 `cp` 行为在 macOS 相同。
2. **同卷保持系统原子重命名语义。** 不要为了保存时间戳把所有移动都改成复制/删除，避免性能与可靠性倒退；需确认同卷识别逻辑的正确性，特别是两个 SMB share 不应凭相同服务器判断为同卷。
3. **跨卷优先保留源文件。** 不覆盖同名文件；目标创建/复制、内容与必要元数据校验、最终确认成功之前，不得删除来源。断连、空间不足、权限失败、校验失败时，默认保留来源并报告失败；对于部分目标文件应设计可清理/可恢复策略。
4. **创建时间戳能力应探测和验证。** 不要假设 Node 的 `fs.utimes` 能修改 birth time。macOS 原生 `FileManager.setAttributes([.creationDate: ...])` 或 `setattrlist` 等只是候选方案，**必须通过 SMB + Samba + NTFS 实测读回确认**；可研究更合适的 Swift/系统 API，但不依赖修改 NAS 服务端作为默认前提。
5. **明确无法恢复时的策略。** 需要提出“严格保留元数据，否则不删除来源”与“允许退化复制并明确告知”的方案及交互，再决定默认行为。**禁止悄悄报告成功，或把时间戳保留失败视为可忽略后继续删源。**
6. **不要牺牲现有能力。** 原有 SMB 挂载、容量条、同卷重命名、复制剪切快捷键、冲突处理、回收站、应用签名/构建流程均要进行回归检查。
7. **兼容老用户配置。** 添加排序字段时，检查视图配置、持久化、恢复默认和迁移逻辑；不要清空已有用户的排序/布局设置。
8. **最小侵入且可向上游 PR。** 尽量沿用现有架构和国际化机制，单一功能提交单独 commit，避免大规模重构。Fork 保留 GPL-3.0 许可声明。
9. **测试隔离。** 只在专用空目录测试，默认使用 1–2 字节、空文件、KB 级文本；必须先获得用户许可才能在 NAS 上做实际写入/剪切测试。**绝不操作现有真实文件或整盘目录。**

## 5. 分阶段推进（原生路线）

详细工作项、文件清单和验收条件统一维护在 [原生版开发与验收计划](docs/NATIVE_METADATA_PLAN.md)，避免同时维护两份不同的开发清单。

| 阶段 | 内容 | 当前状态 |
| --- | --- | --- |
| Phase 0 | 架构、调用链、旧版差异、根因假设、安全边界与测试覆盖审计 | 已完成；未进行 NAS 传输实测 |
| Phase 0.5 | 基于已迁移原生版的独立 validation 构建、隔离检查与本地体验 | 构建/包校验/启动/核心检查及修正后的完整 UI 自动检查通过；体验应用已关闭 |
| Phase 1 | 元数据恢复验证、跨卷保护与逐项结果；回归撤销/还原 | SMB 排他提交及 AppleDouble 兼容修复、Git 本地提交完成；真实 SMB 三轮通过，最终检查与限制见专项复验 |
| Phase 2 | 创建日期列、排序、配置兼容及窄窗口布局 | 实现、限定隔离验收及本地提交完成；见 [Phase 2 验证记录](docs/PHASE_2_VALIDATION.md) |
| Phase 3 | 验证已有网络卷标签，完善未知容量和属性缺失状态 | 实现、隔离验收及本地提交完成；结果见 [Phase 3 验证记录](docs/PHASE_3_VALIDATION.md) |
| Phase 4 | 优先常用 SMB 连接/手动重连及离线恢复；列配置独立可选 | 4A/4B 已提交 `a0a248d`；4C 实现、隔离验收及本地提交收尾完成；见 [4A/4B 记录](docs/PHASE_4AB_VALIDATION.md) 与 [4C 记录](docs/PHASE_4C_VALIDATION.md) |

每阶段分别记录结果。本次 NAS 写入仅获授权执行已公布的专用小夹具；应用安装替换、推送和发布未获授权。

## 6. 验收矩阵（每阶段逐步扩充）

| 测试对象 / 场景 | 预期结论 |
| --- | --- |
| 同一 APFS 卷内移动 | 内容与时间元数据不意外变化，保持同卷移动的效率与正确性。 |
| 同一个 SMB share 内的不同目录移动 | 分别验证是否同卷、内容与时间保留；不误判为跨卷。 |
| `Passport` → `NSSD`，1–2 字节测试文件 | 粘贴结束后检查 `birthtime`、`mtime`、内容哈希；若无法保留，必须明确报告且不得无声删源。 |
| `NSSD` → `Passport`，小型测试文件 | 同上；特别检查目标盘剩余空间及权限。 |
| APFS ↔ SMB，普通复制与剪切 | 分别验证元数据策略与失败行为；普通复制原则上不能损坏源。 |
| 文件夹（含子目录和文件） | 逐项验证元数据、内容和目录最终修改日期，不能只验证目录顶层。 |
| 同名目标、空间不足、只读或断连 | 不静默覆盖；源文件不丢失；显示能理解的错误与恢复路径。 |
| 多文件混合成功/失败 | 操作结果逐项准确；失败的源保留，成功项和失败项清晰区分。 |
| 包含中文、空格的文件名 | 正常传输，避免路径转义问题。 |
| 详细信息视图 / 创建日期排序 | 新列内容正确；升降序、视图设置和重启后排序正常。 |
| 此电脑 / 网络卷容量 | 两个 SMB 盘显示准确的网络卷标签及真实可用空间；原生已有“网络位置”，本地盘仍为本地。 |
| 既有回归测试 | 改动不破坏剪贴板、剪切、拖放、卷卡片、视图持久化与构建。 |

**时间戳验收应同时记录:** 源与目标的原始数值（毫秒或秒）、界面时间、时区、服务器/文件系统、传输是否已结束，以及文件内容校验。对 SMB/NTFS 时间精度差异按实测能力设定容差；不得单凭界面显示到分钟就判为完整保留。

原生检查入口以 `native/README.md` 为准。构建和体验流程见计划中的 Phase 0.5，实际结果见独立验证记录；不要因交接文档中的历史 Electron 命令而运行 `npm ci` 或维护旧版功能。

任何本地核心检查、UI smoke 或构建通过，都不能代替真实 Samba/NTFS 的元数据验收。用户已授权本次公布范围的小夹具测试，不扩大到真实文件、断连或服务器配置。

## 7. Codex 的工作与交付规范

- 继续使用用户 Fork 已有的 `feat/metadata-safe-file-operations` 功能分支，不直接在 `main` 上开发；保留 `upstream` 远程。
- **Phase 0/0.5 已完成，Phase 1 已于 2026-10-20 获授权并实现，专用小夹具 NAS 修复复验也已获授权。用户随后已授权 Phase 2、Phase 3；真实共享仅允许读取卷根属性，不读写现有 NAS 文件、不替换日常安装版。**
- 审计报告至少包含：实际调用链、根因假设与证据、可行的系统 API/技术选型、可能受 Samba/NTFS 限制的功能、失败保护方案、修改文件清单、测试设计、仍需用户确认的决策。
- 开发阶段按 Phase 和功能拆分小 commit；各项实现附对应测试及测试结果。不要把“构建通过”当成“跨 SMB 日期保留问题解决”。
- 对需要真实 NAS 的写入测试，先说明**将创建的专用测试目录、文件数、最大数据量、清理方式、风险**，等用户明确允许后再执行。
- 提交阶段附改动摘要、通过/未通过测试、残余风险、人工验收步骤及必要的回滚方案。

## 8. 后续接手提示词

请先阅读本交接文档、`docs/NATIVE_METADATA_PLAN.md`、`docs/WINDOWS_FILE_OPERATION_BASELINE.md`、`docs/PHASE_1_VALIDATION.md`、`docs/SMB_PHASE1_REACCEPTANCE.md`、`docs/PHASE_2_VALIDATION.md`、`docs/PHASE_3_VALIDATION.md`、`docs/PHASE_4AB_VALIDATION.md`、`docs/PHASE_4C_VALIDATION.md` 及最新 `docs/PERMISSION_ERROR_VALIDATION.md`。Phase 0.5 已提交为 `511f6af`，日常原生 1.1.0 未替换。Phase 1 按 Windows 工作流基准修订，随后已修复 SMB 排他提交、缓存属性和 AppleDouble 目录兼容，并完成三轮真实小夹具复验；具体通过、警告、未运行项及旧现场以最新报告为准。Phase 1 已完成本地提交，提交号以当前分支 `git log` 为准；未推送。用户随后已明确启动 Phase 2；创建日期列、排序和设置已实现并完成隔离验收（核心 665、排序 XCTest 11、UI 389 通过另 1 SVN 跳过），已完成本地提交；详细范围与证据见 `docs/PHASE_2_VALIDATION.md`。旧失败及探针曾保留 35 个专用根；用户随后明确指出残留并要求处理，当前原 35 根及 23 个根伴随文件均已核实不存在，最后 5 个 NSSD 根已由用户在树莓派端清理，精确状态见 `docs/SMB_FIXTURE_CLEANUP.md`。清理仅限原白名单及当前身份匹配项，不能按前缀递归删除共享。不要恢复旧多轮哈希、隐藏来源和阶段日志设计，也不要拿旧检查数量替代当前源码证明。不覆盖复用旧失败或探针目录，不操作现有 NAS 数据；Phase 2 已完成，Phase 3 已完成网络/未知类型与容量状态实现，核心 688、UI 414 通过另 1 SVN 跳过；passport/NSSD 卷根只读核对通过，已完成本地提交，结果见 `docs/PHASE_3_VALIDATION.md`；用户已授权先做 4A 常用连接、4B 状态/恢复，现已完成实现与隔离验收（核心 714、UI 442 通过另 1 SVN 跳过），已完成本地提交，详见最新专项记录；未做真实 NAS 连接/断开/重新挂载测试。4A/4B 已提交 `a0a248d`；用户随后要求“提交，然后4c”，4C 实现与隔离验收完成（核心 728、UI 476 通过另 1 SVN 跳过），已完成本地提交收尾，见新专项记录；不安装替换、不推送或发布。真实 Windows 11 对照、断连/写满与服务端落盘没有验收。

## 9. 已完成的 Fork 初始化

2026-10-19 Phase 0 核对状态：

- 本地仓库与 Fork 已存在，无需重新克隆。
- `origin`：`https://github.com/Metahumanz/Mac-Explorer.git`。
- `upstream`：`https://github.com/qixiaoyu27/Mac-Explorer.git`。
- 功能分支：`feat/metadata-safe-file-operations`。
- 审计基线：`779cbd8b1cdf1c537bf3cfd9248f132222221886`。

继续工作前先检查 `git status`，保留用户已有改动；不重新初始化 Git、不重置分支、不删除 Electron 共享资源。提交按阶段拆分；推送、安装和发布另按用户要求执行。

---

**最终成功标准：** Mac Explorer 仍保持原有界面、SMB 和容量体验；文件列表可直接查看/排序创建日期；网络磁盘识别正确；跨卷剪切与复制时，在目标文件系统能力允许的前提下可验证地保留时间戳，不允许时明确告知并优先保证原数据安全。不能把“在一台 Samba NAS 上通过”扩大表述为“所有 SMB 服务器均保证保留创建日期”。
