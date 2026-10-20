# Phase 2：创建日期列与排序

日期：2026-10-20。用户明确授权开始 Phase 2，基于 Phase 1 提交 `cf3ad70`，沿用 `feat/metadata-safe-file-operations` 分支。业务范围为原生列表、排序及设置；Phase 1 传输逻辑保持原样，Phase 3 尚未开始。本阶段实现、检查和文档已纳入 Phase 2 本地提交；未推送、未安装替换。

## 实现

- `EntrySort.created` 直接使用列表已有的 `FileEntry.created`；不新增内容读取、递归统计或网络查询。目录始终优先，日期相同时按自然名称再按字面路径决胜；与修改日期一致，空日期升序在前、降序在后，零与负 Unix 日期仍为有效值。
- 详情视图在修改日期旁加入创建日期，原四列相对顺序不变，复用现有日期格式/语言/时区；缺失日期显示空白，不借用修改日期。
- 表头、排序菜单和默认排序设置均支持创建日期；菜单切换也同步 AppKit 内部排序描述符，避免后续点击表头从旧方向开始。同步描述符时抑制委托回写，防止无意创建文件夹覆盖。
- 列宽/隐藏规则按列标识配置，移除四列下标假设。优先保留既有列和可读文件名，空间足够时显示新增日期；窄窗口收起新增列，菜单排序仍然可用。没有新增任意列配置系统。
- 沿用 `defaultFolderView` / `folderViews`，兼容旧设置及未知排序值回退，不清空用户设置。简中、繁中、英文使用现有创建日期译文。

## 验证记录

本轮输出根为 `native/output/validation/phase2-20261020T073733Z/`，生成包为 `native/output/validation/Mac Explorer.app`。首次编译在受限环境遇到 SwiftPM 嵌套沙箱 `sandbox_apply` 拒绝，随后通过获准的隔离构建执行；首次新增 UI 检查曾引用私有格式器导致编译失败，已改为检查侧独立格式器，未放宽业务访问权限。两次失败日志保留，不计为通过。

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| `python3 -I native/scripts/check-core.py` | 10 组 665 项通过；含传输 101、文件操作 231、属性 21、回收站 59 | `core.log` / `completed-command-results.json` |
| `swift test --package-path native --filter EntryQueryTests` | 11 个 XCTest 实际执行，0 失败；未声称运行全部 XCTest | `xctest.log` |
| 本地化 | 504 个源字符串在英文及繁体目录检查通过；无需新增重复译文 | `check-localization.py` 本轮输出 |
| `python3 -I native/scripts/build.py --validation` | 最终隔离构建通过，1.1.0、arm64、`local.macexplorer.native-validation`；严格深度签名通过 | `build-final.log` / `delivery-verification.json` |
| `python3 -I native/scripts/smoke.py --validation --skip-build` | 390 条记录：389 项检查通过、1 项 SVN UI 因缺少工具跳过；10,003 项主夹具完整，常规启动三次通过 | `smoke-final/report.json` / `startup-report.json` |
| 创建日期专项 UI | 31 项通过，包含实际菜单与设置控件、AppKit 排序委托、日期值、跨窗口、重置默认、其他布局及六组宽度/窗格组合；另在语言检查中新增简中/繁中/英文三项 | `smoke-final/app.log` / `report.json` |
| 实际进程重启恢复 | 子进程重新读取同一临时偏好域，创建日期默认值、文件夹升序覆盖、表头与实际列表顺序恢复 | `smoke-final/created-date-relaunch.json` |
| 源码及安装隔离 | 最终清单 62 个源码/检查文件匹配；日常安装版程序、Info.plist、原偏好文件哈希未变；`git diff --check` 通过 | `source-manifest.json` / `delivery-verification.json` |

已逐张查看本轮保存的浅色详情、宽窗口创建日期、800 像素带详情窗格及深色紧凑截图：两日期列在宽窗口可读、排序箭头正确；窄窗口隐藏新增列，不挤压名称。截图来自测试夹具，不是用户文件。新增专项输出包括 `native-created-1260-none.png`、`native-created-920-none.png`、`native-created-800-details.png`、`native-created-1100-preview.png` 和 `native-created-dark-compact.png`，均保存在 `smoke-final/`。

首轮 UI 在 `Created-date cell uses birth time: new.txt` 断言停止，主夹具 `fixturePreserved: true`；完整报告和应用日志保留在 `smoke-first-failed/`。该轮夹具使用 Foundation 同时设置创建/修改日期，未事先核对实际值；改用原始 `fsetattrlist`，并在任何 UI 断言之前核对 birth/mtime 原始值，首轮未取得独立读回，不能把未确认的日期夹具差异直接判为业务显示缺陷；最终原始日期准备及全部 UI 检查通过。业务日期读取和展示规则没有为此改动。

## 交付与复查

实现集中在 `EntryQuery.swift`、`BrowserController.swift`、`ExplorerDialogs.swift`，新增 `NativeCreatedDateChecks.swift` 并接入现有 smoke；补充脚本、XCTest 和语言检查。Phase 1 的传输、属性读取、回收站源码与 `cf3ad70` 相同；完整核心回归验证没有破坏既有操作。

剩余人工体验关注新增列在常用窗口宽度下的位置/可读性，以及表头和排序菜单切换的手感。自动检查实际调用了 AppKit 排序描述符委托，没有把程序设定描述符称为真实鼠标点击或触控板验收。当前未测试 macOS 13 实机或真实 Windows 客户端；没有将本地展示功能验收扩展为 NAS 传输保证。隔离验证进程已由脚本退出，产物及报告保留供复查。

收尾时重新核对最终验收清单的 62 个源码/检查文件及成功报告，全部匹配；本轮仅更新文档，不重复构建或运行 UI/NAS 测试。生成包、截图及日志保持忽略，不纳入 Git。

如需回退，应针对 Phase 2 提交进行审阅和撤销，保留 Phase 1 提交 `cf3ad70`。本地输出的 `phase2-review.patch` 保存验收完成时的差异，不含本轮收尾文档更新；最终交付以当前分支的 Phase 2 Git 提交为准。不能用整仓库重置覆盖后续用户改动。

## 隔离和边界

- UI 使用新建本地临时目录、独立偏好域及命名剪贴板，数据/日期检查前后核对；新进程恢复检查沿用同一临时偏好域，退出后清理。
- 没有 NAS 写入或删除、未复用 Phase 1 的旧失败现场；原 35 个专用根按约定保留，不重新计为本轮验收。
- 未声称新增真实 SMB 服务端日期能力或 Windows 全量行为等价；Phase 1 的服务器精度、属性损失警告和跨卷非原子等限制仍然适用。
