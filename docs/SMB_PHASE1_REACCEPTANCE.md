# SMB 提交兼容修复与 Phase 1 复验

日期：2026-10-20。用户授权修复 SMB 提交兼容问题并重新验收。Phase 0.5 独立提交 `511f6af` 保留；Phase 1 实现、检查及文档已纳入本地提交；未安装或推送，Phase 2/3 未开始。[首次失败记录](SMB_VALIDATION.md)作为历史证据保留。

## 修复范围

- 保留同卷排他重命名快速路径。复制前在本次私有目录内用空目录探测真正的排他提交能力；不根据 SMB 卷未声明 capability 就假定支持。
- 不支持时，逐项使用 `O_EXCL`、`mkdirat`、`symlinkat` 排他创建目标，经打开的描述符执行 `fcopyfile`。文件数据只复制一次，不先完成整份暂存复制后再复制一次，不增加内容哈希。此路径的目标在完成前可能可见；日期恢复并读回、目标和来源检查通过后才删源。
- SMB 来源也按逻辑清单逐项复制，避免递归系统复制把原始 AppleDouble 再作为 APFS 普通文件带入；目标支持排他提交时仍在私有 payload 完成后提交。
- 兼容路径失败只清理身份和状态仍匹配的本次创建项，未知新增子项保留并报告恢复位置；不以普通覆盖重命名绕过碰撞保护。
- SMB 打开条目可能刷新此前路径查询的缓存属性，快照以打开的对象建立。身份时间仅接受不足 100 ns 的表示差异，本地仍精确到纳秒；日期验收仍独立核对原始 birth/mtime。
- 实测 NSSD 的 ChangeTime 在刷新后从客户端“当前时间”变成原 mtime，因此 SMB 不使用 ctime 作为稳定变化令牌，仍检查设备/inode/birth、类型、权限、文件大小、mtime 和目录清单。本地 ctime 检查保留。目录大小不作为内容变化凭据。
- SMB 仅将有配对条目、有效 AppleDouble 头部及条目边界的 `._` 文件视为元数据，通过系统扩展属性接口复制其内容；识别只读取有上限的头部，不完整读取资源分支做哈希。APFS 上的同名文件、无配对或无效格式不因前缀而排除。补齐中断和短读取处理，255 字节文件名不再因辅助路径过长而失败。
- 独立小探针复现：部分 AppleDouble 的普通 `read` 返回 `EBADF`，只读标志和 `fstat` 正常；`pread` 可取得有效头部。最终改用显式偏移读取头部和条目表，支持短读取及 `EINTR`；撤回未奏效的句柄重开重试，不忽略普通 `EIO`，不重新读取文件正文。
- 属性失败显示具体属性名称。曾观察到 NSSD 拒绝 `com.apple.provenance`，交互仍由用户选择，无交互默认跳过；没有增加静默忽略名单。测试驱动的“明确继续并保留警告”分支只接受这一已命名属性，其他错误仍停止；无警告与带警告结果分开记录。

系统复制选型及描述符用法参考 [Apple copyfile 手册](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/copyfile.3.html)和 [Apple cp 源码](https://github.com/apple-oss-distributions/file_cmds/blob/main/cp/utils.c)。这里没有把系统复制成功描述成应用已完成内容校验和验证。

## 最终结论

**Phase 1 本轮限定自动验收通过，已完成本地提交收尾；未安装或推送。** SMB 文件和目录往返均保留原创建/修改日期及小夹具内容，碰撞拒绝覆盖。一次系统属性丢失由测试明确选择继续并保留警告；这不是“所有属性均无损”的结论。Phase 2/3 没有开始。

最终业务源码冻结后完成：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 完整核心回归 | 10 组共 654 项通过，其中传输 101、文件操作 231、属性 21、回收站 59 | `core-positioned.log` / `core-positioned-result.json` |
| 独立归档、回收站、本地化 | 全部通过；回收站与核心部分重叠；两翻译目录核对 504 条源字符串 | `archives-positioned`、`trash-positioned`、`localization-positioned` 的日志和状态 |
| 隔离原生构建 | 1.1.0、arm64、`local.macexplorer.native-validation`；严格深度签名校验通过 | `build-positioned.log` / `delivery-verification.json` |
| 最终完整 UI 复验 | 356 条记录：355 项检查通过，1 项 SVN UI 因工具缺失跳过；10,003 项夹具保持完整；常规启动三次通过 | `smoke-positioned-report/report.json` / `startup-report.json` |
| 源码对应和安装隔离 | 核心与 NAS 运行清单匹配，应用源码与最终构建清单匹配；日常安装程序、Info.plist、原偏好文件哈希未变 | `final-source-manifest.json` / `delivery-verification.json` |

本地输出根：`native/output/validation/phase1-smb-acceptance-20261020T064444Z/`。隔离包仍位于 `native/output/validation/Mac Explorer.app`。核心检查不是 XCTest；没有替换 `/Applications/Mac Explorer.app`。

本次直接修改的核心为 `VerifiedTransfer.swift`（能力探测、排他创建、逻辑清单复制和清理保护）、`FileTransferControl.swift`（描述符系统复制及属性错误信息）、新增 `AppleDoubleCompanion.swift`（有界格式识别和定点读取）。传输检查、显式 SMB 驱动及归档/回收站编译入口同步更新，文档同步当前授权与结果；此前 Phase 1 的 UI、属性读取、剪贴板和撤销接入与本次 SMB 修复一并纳入 Phase 1 提交。

`phase1-review.patch` 保存最终验收时相对 Phase 0.5 提交 `511f6af` 的 Phase 1 补丁（含新增文件），不含本轮文档收尾更新；最终交付以当前分支的 Phase 1 Git 提交为准。收尾时重新核对 58 个应用源码及 21 个 NAS 运行源码/驱动文件哈希，均匹配最终验收清单；本轮只更新文档，不重复执行 NAS 测试。应用侧无需撤销安装或系统设置；源码回退仅涉及审阅确认的 Phase 1 文件，不应重置整个仓库或撤回 `511f6af`。

## 真实 SMB 最终矩阵

最终 UUID：`C97B5FCD-8928-4EB3-A535-153F9BF75823`。运行程序没有强制跨卷、替代复制、替代日期恢复或替代重命名，仅记录检查点和测试错误决策，执行实际文件操作分支。

| 轮次 | 实际场景 | 结果 | 数据实例预算 / 逻辑字节 |
| --- | --- | --- | --- |
| 1 | 本地向两共享复制、NSSD→本地剪切、两共享双向剪切、两个同共享移动、同名保护、本地→passport剪切 | 9 个场景通过；无属性损失警告；碰撞按预期拒绝并保留两端 | 12 / 24 B |
| 2 | 含空文件、中文空格名、子目录的树：本地→NSSD→passport→本地→passport→NSSD，五次剪切 | 5 个场景通过；逐项内容及文件/目录日期一致 | 12 / 12 B |
| 3 | 两共享→本地普通复制及属性能力观察 | 3 条场景记录通过；本轮属性拒绝没有触发，不能把这条观察算成实际 NAS Skip 故障分支通过 | 6 / 12 B |

第二轮第一项复制子文件时，NSSD 返回 `EPERM (com.apple.provenance)`；测试驱动明确选择 `continueWithoutProperties`，结果包含属性警告，`datesVerified: true`，独立日期和内容复核通过。后续移动正常。应用没有静默忽略该属性，也没有把这次结果记成所有属性保留；Skip/Retry/Cancel 的故障保护由本地注入与 AppKit 对话框检查另行覆盖。

所有成功系统复制项均未宣称应用校验和已验证（`contentVerified: false`）。测试驱动只对自建 0/2 字节数据计算 SHA-256，独立核对原始秒/纳秒时间；SMB 按 100 ns 表示精度比较。各轮结束后延迟两秒复核，再按身份及已知清单清理。九个最终专用根及其根伴随文件已通过独立只读检查确认不存在。

NAS 输出：`native/output/validation/smb-fix-20261020T071203Z-C97B5FCD/`，包括 `plan.json`、`core-source-manifest.json`、程序 SHA-256、三轮 `nas-round-N.json` / 日志 / 返回状态，以及 `independent-cleanup-readback.json`。本轮小夹具验证的是 macOS 挂载端的核心调用链；没有将其当作真实 Windows 11、NAS 拖放/剪贴板/属性窗口人工验收或服务器掉电持久性验证。

## 历史失败、诊断与保留现场

全部失败报告保留，没有覆盖成通过。首次修复前的 `RENAME_EXCL` 不支持见 [历史记录](SMB_VALIDATION.md)；后续诊断分别暴露属性缓存、AppleDouble 重复复制、顺序读取 `EBADF` 和 255 字节文件名回归。当前使用最终 `pread` 版本及最终源码清单，不以中间通过替代最终结果。

最终构建前的一次完整 UI 运行在 Quick Look 状态等待超时，夹具完整；保留于 `smoke-delivered-report/`。没有改 Quick Look/VCS 或放宽断言，最终构建在核心与 NAS 操作结束后完整复验通过；该历史间歇性 UI 失败原因尚未确认。更早的中间构建、局部检查和失败日志也保留，不合并冒充最终通过。

**仍保留 11 组失败矩阵现场和 1 组独立探针，共 35 个专用根（23 个 NAS、12 个本地），155 个内部条目。** 成功最终轮已清理；这些旧现场未覆盖复用或自动删除。精确绝对路径、设备/inode、原始 birth/mtime 纳秒、大小和根伴随文件均列在本地输出的 `preserved-fixture-inventory.json`，概览见 `preserved-fixture-summary.json`。范围只包含各已公布测试根，不扫描现有用户目录；后续清理应核对该明确清单和当前身份，不能按前缀递归删除共享内容。

探针 UUID 为 `0F5346C5-B0CF-45F5-A1DE-18F5243E1616`，仅本地与 NSSD 两根、4 个数据实例、4 B 内容；`smb-fix-work/header-probe-result.json` 记录普通读取失败、关闭非阻塞/缓存无效及定点读取成功。它是读取兼容诊断，不计入最终 NAS 矩阵通过项。中间尝试的元数据句柄重开重试没有解决问题，已撤回。

一次执行曾被自动审批因“当前运行指针可能复用旧现场”拦截，未执行 NAS 操作。只读核实计划 UUID 和九个根不存在后，改为固定绝对计划路径及执行前再次断言，随后获准执行；没有复用旧目录或绕过批准范围。

## 范围和限制

真实共享为 `/Volumes/passport` 与 `/Volumes/NSSD`，不使用其他挂载、不查询账号地址或服务器配置。每轮仅使用新 UUID 专用根、0/2 字节数据夹具，最多 12 个数据文件实例和 64 KiB 逻辑内容；系统生成的 AppleDouble 元数据另列，不计作用户测试数据文件。异常现场保留，成功轮只核对清理自己的条目；不按前缀批量删除。

两个 SMB 卷均不支持本次排他重命名探测，因此同共享移动也可能执行一次复制再删源。这会增加同共享大文件的 I/O，不能宣称与 Windows 服务端原地重命名的性能相同；本地支持的重命名保持快速路径。

轻量元数据检查无法检测大小、mtime 等均保持不变的同长度内容改写，SMB ctime 映射也不提供额外保证。跨卷传输不是原子事务；网络阻塞、进程终止、外部最后时刻改写、服务器落盘、Windows 客户端显示及真实写满/断连不在本轮通过范围。资源分支和链接的本地回归不等于全部 NAS 组合已验收。
