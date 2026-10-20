# Fork 并行安装与源码交付

日期：2026-10-20。用户授权：提交已验证的改动，push 当前功能分支，然后将我们的版本安装到 Applications，保留原应用。

## 安装身份与边界

| 项目 | 原应用 | 本 Fork |
| --- | --- | --- |
| 应用路径 | `/Applications/Mac Explorer.app` | `/Applications/Mac Explorer Fork.app` |
| Bundle ID / 偏好域 | `local.macexplorer.native-prototype` | `local.macexplorer.native-fork` |
| 支持文件目录 | `~/Library/Application Support/Mac Explorer Native` | `~/Library/Application Support/Mac Explorer Fork` |
| 更新渠道 | 沿用原应用 | 不启动上游自动检查，也不提供上游更新安装入口 |

本 Fork 的文件查看器接入使用自己的 Bundle ID 和自己的恢复备份；安装过程不启用它、不修改默认处理器，也不继承原应用偏好。回收站来源记录和 VCS 备份分开存储，系统回收站本身仍是 macOS 的公共回收站。

源码版本继续为 1.1.0，按本地分支构建处理，不创建或覆盖正式版本/tag。Fork 名称和独立标识区分安装，`Info.plist` 的 `MacExplorerSourceRevision` 记录构建源码提交；ad-hoc 签名，未经过 Developer ID 签名或 Apple 公证。

## 可复现入口

先在干净的当前分支完成提交和推送，再构建安装：

```sh
python3 -I native/scripts/build.py --fork
python3 -I native/scripts/install-fork.py
```

构建输出为 `native/output/fork/Mac Explorer Fork.app`。安装器只接受这一名称及 `local.macexplorer.native-fork`，验证架构、签名、文件散列；在 Applications 内暂存，再通过 Darwin `RENAME_EXCL` 排他提交。目标已有应用、普通文件或符号链接时一律拒绝，不升级、不覆盖、不合并目录，也不会回退到原应用路径。以后升级本 Fork 需另行确认替换范围，不用删除原应用来安装。

精确验证构建包或安装包：

```sh
python3 -I native/scripts/smoke.py --skip-build \
  --app '/Applications/Mac Explorer Fork.app' \
  --output native/output/validation/fork-install-20261020/installed-smoke
```

`StartupCheck` 在普通启动检查前快照对应应用的偏好域，退出后恢复，避免测试窗口目录留作用户下次启动的会话。其余文件操作使用临时夹具和独立测试偏好，测试不写真实 NAS，不替换日常应用。

## 验证及交付证据

- 启动设置提交：`bb6d3ba`，此前核心专项 121、完整 UI 526 通过另 1 SVN 跳过，见 [启动设置记录](START_LOCATION_VALIDATION.md)。
- Fork 安装器 7 项签名临时夹具检查通过：安装、原应用哨兵保留、已有 Fork 保留、普通文件碰撞、目标符号链接、目录符号链接和错误应用标识拒绝。
- 系统/更新核心 60 项通过，其中新增 5 项检查 Fork 文件查看器独立身份/恢复及拒绝上游更新安装身份；不使用真实系统偏好作写入夹具。
- 精确 Fork 构建包完整 UI 528 项通过、1 项 SVN UI 因缺少工具跳过；普通启动 3 次、各独立子进程恢复检查通过，10,003 项主夹具保持完整。包含独立偏好域、支持目录及 About 页排除上游更新控件的真实 AppKit 检查。精确构建包与安装后校验、完整 UI、原应用全部文件/偏好散列比对、远端提交核实记录在 `native/output/validation/fork-install-20261020/`，以实际完成的日志/结果为准。

本次只推送 `feat/metadata-safe-file-operations` 到自己的 `origin`；远端 main 的新改动只有 README，整合到当前功能分支，不更新远端 main，不合并回 main、不打 tag、不创建 GitHub Release。本地 `.command` 继续忽略，不随分支推送。
