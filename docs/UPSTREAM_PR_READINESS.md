# 上游 PR 准备记录

> 本文保留整合前的 PR 差异分析快照。用户随后授权拉取上游并解决冲突，当前整合与验证结果见 [上游合并记录](UPSTREAM_MERGE_VALIDATION.md)；下文的 HEAD、冲突数量及“尚未合并”描述均对应整合前状态。拆分 PR 的范围建议仍适用。

核查日期：2026-10-21。本轮只完成安装交付核对、上游差异分析和本地 PR 材料准备；没有创建 PR、合并上游到当前分支或操作真实 NAS 文件。

## 当前交付与比较基线

- 当前分支：`feat/metadata-safe-file-operations`，HEAD `8a19917bc76037e6fb30c208078b938fee2ee352`，已推送到 `Metahumanz/Mac-Explorer` 同名分支。
- 已安装并打开 `/Applications/Mac Explorer Fork.app`，版本 1.1.0，bundle ID `local.macexplorer.native-fork`，源码修订与 HEAD 一致。安装版 UI 528 项通过，1 项 SVN UI 因工具缺失跳过，夹具完整；安装文件与构建产物一致，原应用及原偏好未改变。
- 上游：`qixiaoyu27/Mac-Explorer:main`，本次 fetch 得到 `d1aaa499f962c7a686ba05ef2f6e16da522dfd5e`，原生版本 1.2.2。
- 共同祖先：`f48821ac32f3a91b79fb45b2bb8fbdf8dfdc78f2`。上游独有 8 个提交，当前分支独有 10 个提交。
- `git diff upstream/main...HEAD`：73 个文件，新增 5,259 行、删除 247 行。这包含多阶段功能、Fork 安装工具和个人验收记录，不建议直接作为一个上游 PR。
- 核查时上游没有打开的 PR。此结论及冲突分析只对应上述 SHA，提交前需要重新 fetch。

安装证据：[delivery-checks.json](../native/output/validation/fork-install-20261020/delivery-checks.json)。本地生成证据保持忽略，不上传到上游。

## 整个分支试合并：存在 5 个冲突文件

使用 `git merge-tree --write-tree upstream/main HEAD`，返回码 1。此操作没有改变当前工作区、索引或分支；生成的合成树仅用于检查，尚未编译或验收。

| 文件 | 冲突原因 | 处理方向 |
| --- | --- | --- |
| `native/README.md` | 双方增加原生功能及开发说明 | 保留上游安装、终端、AirDrop 说明；只增加本 PR 涉及内容，不带入 Fork 安装及个人验收目录 |
| `native/Resources/locales/en.json` | 双方在字典末尾追加文案 | 按键合并，而非选整份文件；保留全部上游新增键 |
| `native/Resources/locales/zh-TW.json` | 同上 | 同上，并校验占位符与重复键 |
| `native/Sources/MacExplorerNative/ExplorerSpecialView.swift` | 上游加入 AirDrop 设备发现；本分支加入卷加载注入、SMB 收藏和连接状态 | 统一初始化参数，分别保留 AirDrop/SMB 生命周期、取消与过期回调保护；重新核对三种特殊页面布局 |
| `native/Sources/MacExplorerNative/NativeSmoke.swift` | 双方添加专项入口和检查调用 | 合并两侧入口与检查，保留上游终端/AirDrop/VCS 回归；修复下述排序测试语义冲突 |

两份翻译文件分别有上游 12 个、本分支 56 个新增或修改键；没有双方改成不同值的同名键，也没有重复键。因此当前翻译冲突是追加位置重叠，不是文案取舍冲突。

原始输出：[merge-tree.txt](../native/output/validation/pr-readiness-20261021/merge-tree.txt)；翻译分析：[locale-analysis.json](../native/output/validation/pr-readiness-20261021/locale-analysis.json)。

## 文本自动合并仍需处理的问题

1. **排序测试有语义冲突。** 上游 `d1aaa49` 用 `sortMenu()[5]`、`[4]` 触发降序、升序。本分支增加“创建日期”排序项后，这些位置会变化。移植创建日期时应按明确菜单标题或稳定标识查找并断言存在，同时保留上游对设置持久化的检查，不能直接沿用旧下标。
2. `BrowserController.swift` 自动合并不代表验收通过；必须保留上游终端偏好调用 `NativeTerminal`，同时核对本 PR 的传输、错误处理或启动位置接入。
3. `ExplorerDialogs.swift` 必须保留上游快捷键设置的单层滚动修复与终端选择器，再接入默认启动位置或列设置；上游 PR 不引入 Fork 的更新控件隐藏逻辑。
4. `Views.swift` 必须保留上游项目悬停背景修复，再核对表头菜单及深浅色状态。
5. `native/scripts/build.py` 必须保留上游网络隐私文案。Fork 构建参数、独立安装脚本及应用身份隔离属于本 Fork 的交付范围，不随业务修复提交。
6. 上游已是 1.2.2。上游 PR 不把版本改回 1.1.0，不改发布分支、Homebrew、更新地址、签名或系统默认应用。

## 建议拆分顺序

各 PR 都从提交当时的最新上游 `main` 建立独立分支，使用 `codex/` 前缀。以下是准备名称，尚未创建或推送这些分支。

| 顺序 / 建议分支 | 上游 PR 范围 | 主要依赖及复核 |
| --- | --- | --- |
| 1 · `codex/smb-preserve-dates` | SMB 复制/跨卷移动的日期保留、排他提交兼容、AppleDouble 识别、进度与错误决策、相关回归 | 以 `cf3ad70` 为来源；先单独审查删源条件、失败清理、属性丢失确认及额外 I/O |
| 2 · `codex/created-date-columns` | 创建日期列和排序、详细信息列配置 | 对应 `94b79b7` 及 `96c79d5` 的列设置部分；处理排序菜单下标、设置与本地化 |
| 3 · `codex/network-drive-details` | 网络卷类型、未知容量显示 | 对应 `0dd7470`；保留上游 AirDrop，区别 SMB 与其他远程文件系统 |
| 4 · `codex/saved-smb-connections` | SMB 收藏、连接状态、取消、手动恢复 | 对应 `a0a248d`；依赖卷分类，重点解决特殊页面与上游 AirDrop 冲突 |
| 5 · `codex/file-access-errors` | 权限错误保留实际子路径和系统原因，避免把网络权限误诊为隐私授权 | 从 `96c79d5` 单独提取错误处理部分；不能整提交连带列设置 |
| 6 · `codex/network-delete-confirmation` | 网络项永久删除确认、本地回收站及混合选择路由 | 对应 `ff7e30b`；与传输保护相关，单独审查不可撤销语义；目前没有真实 NAS 永久删除实测 |
| 7 · `codex/default-start-location` | 设置默认打开“个人文件夹”或“此电脑” | 对应 `bb6d3ba`；独立接入上游设置及 smoke，保留显式路径优先和原有会话恢复规则 |

`511f6af` 的视口修复应先核对上游当前 UI 是否仍需要，再单独考虑；不把 Phase 0.5 的整个验证文档作为修复提交。

不纳入上述 PR：Fork 专属应用名、bundle ID、存储目录、更新策略、`NativeAppProfile.swift`、`install-fork.py`、`check-fork-install.py` 及相关 Fork 检查；本地 `.command` 启动器；`CODEX_HANDOFF_Mac-Explorer.md`；阶段审计、个人 NAS 路径/现场清单及安装交付记录；构建产物、日志和个人配置。保留必要、可复现且去除个人环境信息的回归说明即可。

## 已准备的第一份候选补丁

从 `cf3ad700dbdfa7170bae601509fb75050e22578d` 提取 17 个原生源码、翻译和回归脚本文件，不含个人文档或 Fork 安装变更。原始补丁在最新上游仅两份翻译文件无法直接应用，其他 15 个文件 `git apply --check` 通过。

已按键合并该提交的翻译增量并保留上游键，生成完整候选补丁；在临时目录重建对应上游文件后，完整 `git apply --check` 通过。临时检查目录已清理。

- [SMB 候选补丁](../native/output/validation/pr-readiness-20261021/smb-transfer-upstream-candidate.patch)
- [候选补丁检查结果](../native/output/validation/pr-readiness-20261021/smb-candidate-check.json)
- [原始提取补丁及启动位置提取检查](../native/output/validation/pr-readiness-20261021/focused-patch-checks.json)
- [第一份 PR 正文草稿](../native/output/validation/pr-readiness-20261021/smb-pr-body.md)

**当前只证明补丁能够应用，不证明在上游 1.2.2 基线上已编译或通过运行验收。** 当前安装版与已有 Phase 1 测试结果不能代替移植后结果。启动位置原始补丁还需要重接 `NativeSmoke.swift`，并合并两份翻译，不能直接 cherry-pick 宣称完成。

## 实际提交前必须完成

1. 重新 fetch 并固定上游 SHA；从上游建立对应单一功能分支，应用候选补丁并审查最终差异。避免直接向当前已安装的 Fork 分支合并所有上游变更。
2. 在隔离构建中运行该分支的 `python3 -I native/scripts/check-core.py`、`python3 -I native/scripts/build.py --validation`、`python3 -I native/scripts/smoke.py --validation`，以及对应归档、回收站、本地化等受影响检查。GUI 验证应与用户手动测试错开。
3. SMB 修复审查重点：系统复制一次、不新增应用全文件哈希；同名不覆盖；仅在目标检查通过后删源；来源/父目录身份变化中止；AppleDouble 识别严格；属性丢失必须明确决策；清理失败报告实际位置。
4. 需要真实 SMB 复验时，先限定新的 UUID 夹具、数量/大小和清理范围，沿用已授权的小夹具边界；不直接运行旧驱动操作已有 NAS 文件。真实断网、写满、掉电和 Windows 客户端显示仍没有验收证据。
5. 在 PR 正文区分该上游分支的测试结果与历史 Fork 测试。当前草稿的“待完成”内容在实际运行后据实替换；不能写成全部通过。
6. 检查 `git diff --check`、变更范围和个人信息；提交前复核上游是否再次前进。只有用户明确要求提交 PR 后才创建，并核对目标仓库及 base 分支。

本轮没有开始上述移植与运行验收，也没有创建、发布或推送 PR 分支。当前 Fork 业务代码和安装包保持原样。
