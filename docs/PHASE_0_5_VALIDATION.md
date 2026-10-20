# Phase 0.5：原生隔离构建与验证记录

日期：2026-10-19。源码基线：`779cbd8b1cdf1c537bf3cfd9248f132222221886`。分支：`feat/metadata-safe-file-operations`。初次验证没有修改源码；用户要求继续后，定位并修正了两处视口宽度计算，补充相关 UI 回归。未修改文件操作或构建脚本。

## 结论

隔离原生版构建、包标识/签名/架构校验、普通启动检查及九组核心检查通过。初次完整 UI smoke 两次因双指前进断言失败而中止；后续定位并修正视口宽度计算后，完整 AppKit smoke 的 352 条记录（351 项检查通过，1 项 SVN UI 因未安装工具跳过），夹具完整性检查通过。初次失败记录继续保留。

曾打开 validation 应用供用户在专用临时目录体验，并确认窗口显示测试项目。用户要求关闭后已退出，后续自动检查结束也正常退出，未重新留下体验窗口。Phase 0.5 自动验证已完成；未将此结果视为真实触控板或 NAS 验收，没有进入 Phase 1。

## 环境与隔离

| 项目 | 本轮结果 |
| --- | --- |
| 主机 | Apple Silicon，macOS 27.0.1，Swift 6.4，完整 Xcode 工具链 |
| 构建命令 | `python3 -I native/scripts/build.py --validation` |
| 产物 | `native/output/validation/Mac Explorer.app` |
| 版本 | `1.1.0` |
| Bundle ID | `local.macexplorer.native-validation` |
| 架构 | `arm64` |
| 签名 | ad-hoc；`codesign --verify --deep --strict --verbose=2` 通过；不代表 Apple 公证 |
| 日常安装版 | `/Applications/Mac Explorer.app`，`local.macexplorer.native-prototype`，未替换 |

首次标准命令被执行环境的嵌套沙箱限制阻止，报 `sandbox-exec: sandbox_apply: Operation not permitted`。获准在所需执行权限下运行同一构建后成功；未改写构建脚本或应用签名策略。编译缓存和本轮日志位于忽略提交的 validation 输出目录。构建出现既有弃用和捕获语义警告，未作为业务修复处理。

文件操作检查限定本地临时夹具，UI 自动检查使用测试偏好域、命名剪贴板及模拟回收站。系统文件查看器使用测试 fixture 入口。只读枚举挂载卷属性不等于 NAS 文件传输验收；本轮没有挂载/断开共享、读写真实 NAS 文件、推出卷或修改系统默认项。

本轮开始与结束分别对已安装应用的 `Info.plist`、`MacOS/MacExplorerNative` 和 `~/Library/Preferences/local.macexplorer.native-prototype.plist` 取 SHA-256，三者均保持一致。这是对这些文件的检查，不宣称审计了所有系统状态。

## 核心检查

命令：`python3 -I native/scripts/check-core.py`。返回码 `0`，共 **548 项通过**，为项目独立检查，非 XCTest。

| 检查组 | 通过项数 |
| --- | ---: |
| CoreChecks | 69 |
| FileActionChecks | 231 |
| PropertiesChecks | 16 |
| WatcherChecks | 18 |
| QuickAccessChecks | 16 |
| LatestCoreChecks | 27 |
| NetworkChecks | 57 |
| TrashChecks | 59 |
| SystemChecks | 55 |

未运行 `swift test`、独立归档/VCS/安装脚本、Electron 测试或真实跨卷日期实验；这些项目不能记作本轮通过。548 项核心结果来自初次验证；后续只修改 AppKit 布局和其 UI 检查，ExplorerCore 未变，未机械重跑。

## 初次 AppKit 检查：保留失败证据

命令：`python3 -I native/scripts/smoke.py --validation --skip-build`。

| 项目 | 第一次 | 第二次 |
| --- | --- | --- |
| 普通启动 | 三次启动均出现窗口并保持至少 3 秒 | 同样通过 |
| UI smoke 返回码 | `1` | `1` |
| 失败点 | `Main browser double-finger forward works in details` | 相同 |
| 夹具完整性 | `fixturePreserved: true` | `fixturePreserved: true` |

失败来自 `native/Sources/MacExplorerNative/NativeInputNavigation.swift` 的 `NativeInputNavigationChecks.runBrowser`：模拟双指后退后，模拟前进没有满足预期目录断言。该检查在主 smoke 很早的位置执行；返回的 `checks` 为空，后续完整视图、文件操作、剪贴板、属性、设置等 UI 检查未执行，不能把旧报告的通过数量补到本轮。

初次验证结束时尚未定位根因，没有跳过断言。用户要求继续后进行了下述诊断与修正；诊断产物和初次失败报告不能代替最终产物的通过证据。

## 后续诊断、局部修正与完整复验

用户要求关闭体验应用并继续，先完成 Phase 0.5 阻塞处理，未展开 Phase 1。

1. 正常退出 validation 体验应用；只增加断言诊断信息后复现：加载已结束、前进按钮可用，但目录仍在后退后的位置，排除路径字符串比较误报。
2. 强制完成布局后仍失败。尺寸诊断显示表格宽度为 934 点、滚动视口宽度为 919 点。常驻滚动条占用的 15 点被计入了文件内容宽度，导致 `NativeInputNavigation` 的横向滚动保护将手势留给滚动，而不执行前进。
3. `BrowserController.swift` 中详细表格和图标集合改为根据 `contentView.bounds.width` 布局。只先修正表格时，详细视图原断言通过，图标视图复现同类失败，随后对集合视图作同样修正。文件操作、元数据处理及手势判定逻辑均未修改。
4. `NativeInputNavigationChecks.runBrowser` 保留后退/前进断言，并验证两种视图在 `.legacy` / `.overlay` 滚动条下均无意外横向溢出；事件前完成布局并重新计算坐标，检查结束恢复原局部滚动条样式，不修改系统设置。临时尺寸打印已移除，失败时的目录/状态诊断保留。
5. 重建最终 validation 包，运行原有完整 smoke：返回码 `0`，`passed: true`，**351 项检查通过，1 项 SVN UI 跳过，共 352 条记录**，`fixturePreserved: true`；三次启动检查通过。原先阻塞点及随后视图、文件操作、剪贴板、设置、窗口等检查已运行。
6. 最终包标识/版本、arm64 和严格深度签名校验通过；安装版的程序、Info.plist 和偏好文件哈希仍与初次验证前一致。`git diff --check` 通过，查看本次生成的图标和窄窗口夹具截图，未见布局错位。

该结果针对本机 AppKit 事件与临时夹具，未覆盖真实触控板硬件或真实共享传输。未安装替换、未推送、未发布；本次 Phase 0.5 提交仅包含视口修正、对应 UI 检查及阶段文档；Phase 1 文件操作改动另行处理。

后续证据根目录为 `native/output/validation/phase0.5-followup-20261019T114902Z/`：

- `diagnostic-smoke-report/`：增加目录诊断后的复现。
- `layout-smoke-report/`：仅完成布局仍失败及 934/919 尺寸诊断。
- `viewport-smoke-report/`：只修正表格后，在图标视图复现同类问题。
- `both-views-build.log`、`both-views-smoke.log`、`both-views-smoke-report/`：最终构建与完整通过报告。
- `final-verification.json`、`source-changes.patch`：最终包及安装版检查、对应源码差异。

上述均为生成文件，忽略提交。测试应用随 smoke 正常退出，未重新打开体验窗口。

## 用户体验入口

已使用明确的 validation 包路径启动；本次启动以参数设置 `automaticUpdateFrequency=never`、空 `wakeShortcut`，不更改日常应用偏好。

- 本地体验根目录：`/private/tmp/mac-explorer-phase05-experience-j25grvb2`。
- 初始目录：该根下的 `Documents`。
- 测试数据：5 个普通文件，共 153 字节；包含空文件、2 字节文本、中文/空格名称及隐藏文件，另有子文件夹、本地相对目录链接和空目标目录。
- 已通过辅助功能读取确认：窗口为 `Documents — Mac Explorer`，地址为上述临时路径，图标视图显示 5 个可见项目。此处是窗口和夹具显示检查，不是全部交互或真实触控板验收。
- 测试文件可在本临时根目录内尝试；不要使用该产物操作真实 NAS 数据。隔离标识与测试目录不构成应用文件系统沙箱；手动复制仍使用系统剪贴板，普通删除仍走系统回收站。
- 为用户体验保留临时目录和构建，未自动清理。后续只在关闭该 validation 应用且不再需要夹具时清理这个确切目录，不能匹配前缀批量删除。

## 日志和后续状态

本机生成证据根目录：`native/output/validation/phase0.5-20261019T105250Z/`（忽略提交）。

- `baseline.json`、`installed-integrity-final.json`：日常安装版检查。
- `build.log`：首次环境阻塞；`build-permitted.log`、`build-permitted-result.json`：成功构建。
- `artifact-checks.json`：包标识、版本、签名、架构及可执行文件哈希。
- `core.log`、`core-result.json`：九组核心检查。
- `smoke-attempt-1/`、`smoke-attempt-2/`：各次独立启动报告、失败报告及应用日志；驱动日志位于同根目录。
- `experience-fixture.json`、`experience-launch.json`：体验夹具清单、初始文件哈希及启动参数。

当前状态：UI smoke 阻塞已处理，完整自动复验通过；日常安装版未改变，体验应用已关闭。本文记录 Phase 0.5 验证时点；后续 Phase 1 状态见交接文档，真实 NAS 写入仍需单独授权。相关计划见 [原生版开发与验收计划](NATIVE_METADATA_PLAN.md)。
