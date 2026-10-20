# 默认启动位置设置与验证

日期：2026-10-20。用户要求把本地启动脚本中的选择移入文件资源管理器设置，并核对全部既定任务。

## 行为

“设置 → 常规 → 启动位置 → 默认打开”提供“此电脑 / 个人文件夹”。沿用常规设置即时保存的交互，选择不跳转当前窗口；后续普通启动、新窗口、新标签页、Dock 和无窗口重新唤起使用同一偏好。未设置或值非法时保留既有“个人文件夹”默认，只接受两个稳定标识，不能通过该偏好打开任意路径或网络地址。

启动优先级：显式 `--path`、外部打开文件/目录及专用测试路径仍覆盖默认值；“退出并保留窗口”和更新恢复仍按已有保存会话恢复（原实现保留个人文件夹固定页，不保存活动标签页索引）。启动位置与会话内容独立，不清空已有会话，也不替换已打开的标签页。保留工作区原有 `explorer://…` 显式路径解析修正，汇入同一初始地址解析入口。

根目录 `打开隔离测试版.command` 已移除终端选择菜单、`--path` 强制路径和单独的本地选择文件读写；脚本仅打开隔离包，启动位置完全由应用设置控制。脚本继续通过 `.git/info/exclude` 仅本地忽略，不提交、不安装日常版；应用正在运行时双击唤起已有实例，改变默认位置不会重定向已有窗口。

Windows 的对应入口是 Options → Open File Explorer to；见 [Microsoft Support](https://support.microsoft.com/en-au/windows/experience/fileexplorer/file-explorer-in-windows)。本项目按用户要求使用现有“个人文件夹”，没有把它混称为 Windows 的 Home/Quick access 聚合页面。

## 本轮验证

证据目录：`native/output/validation/start-location-20261020/`。本轮实际结果如下；既往阶段数量不充当本轮全套核心检查。

- 核心专项：`LatestCoreChecks` 41 项（新增启动位置 14 项）及 `CoreChecks` 80 项通过，共 121 项；覆盖默认回退、虚拟位置、显式路径优先级及非法值。
- 新增 AppKit 工作流覆盖实际下拉选择、双窗口、不跳转当前页、新标签、新窗口、Dock、无窗口唤起、外部文件打开、会话保留、独立进程偏好恢复和源内容保持。
- 最终完整 AppKit smoke：527 条记录，526 项通过、1 项 SVN UI 因工具缺失跳过；新增启动设置工作流 15 项通过，另有独立进程恢复 2 项及普通启动 3 次通过；10,003 项主夹具保持完整。
- 隔离包为 1.1.0、arm64、`local.macexplorer.native-validation`，严格深度签名验证通过；两个语言目录与包内资源一致，本地化 534 个源码字符串通过。
- 最终源清单与构建/测试源码一致；日常安装版可执行文件、Info.plist 和偏好设置与先前基线散列一致；新建启动设置与核心测试临时根均只读核实不存在。`.command` 可执行、语法通过且仍被本地 Git 排除。
- 完整证据为 `core.log`、`build-final.log`、`smoke-final.log`、`smoke-final/report.json`、`smoke-final/startup-report.json`、`smoke-final/start-location-relaunch.json`、`source-manifest.json`、`fixture-cleanup-readback.json` 和 `delivery-checks.json`。已查看设置页截图，启动位置下拉框清晰可见，控件没有重叠。
- 本轮没有运行 XCTest；不将独立子进程的“持久化恢复”检查扩大为所有生产冷启动/系统恢复场景的实机验收。

本轮验证未运行真实 NAS 写入，未修改系统默认文件处理器，未安装、推送或发布。用户随后已授权本地提交、推送当前功能分支并在 Applications 并行安装，后续交付独立记录。全部既定任务核对见 [完成度审计](TASK_COMPLETION_AUDIT.md)。

首次完整 UI 在新检查“按保存列表精确顺序恢复”处停止，主夹具完整。只读复核发现上游 `restoreLocations` 原本固定将个人文件夹放在第一项；已将新检查改为验证既有固定页及保存位置均保留，没有为满足测试而修改会话恢复业务。首次证据保存在 `smoke-first-failed/`。
