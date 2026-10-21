# 上游 1.2.2 合并与隔离验收

日期：2026-10-21。用户授权拉取上游新进度并解决冲突。本轮在现有 `feat/metadata-safe-file-operations` 分支合并上游 `main`，不替换已安装应用、不创建 PR、不操作真实 NAS 文件。

## 合并范围与冲突处理

- 合并前 HEAD：`8a19917bc76037e6fb30c208078b938fee2ee352`。
- 本轮 fetch 的上游：`d1aaa499f962c7a686ba05ef2f6e16da522dfd5e`，共同祖先 `f48821ac32f3a91b79fb45b2bb8fbdf8dfdc78f2`。
- 纳入上游 8 个提交：终端偏好、AirDrop 设备发现、快捷键设置滚动修复、项目悬停背景修复、排序动作回归，以及 README/Homebrew 安装与发布维护说明。
- `native/VERSION`、`package.json` 和锁文件跟随上游为 1.2.2；不创建 tag 或 Release。

实际处理 5 个冲突文件：

| 文件 | 处理结果 |
| --- | --- |
| `native/README.md` | 同时保留上游终端/AirDrop 说明和 Fork 的日期、列、网络卷、连接及安装说明 |
| `native/Resources/locales/en.json` | 按键合并上游 12 个新增键，保留 Fork 键和原逐行格式；没有不同值的同名键冲突 |
| `native/Resources/locales/zh-TW.json` | 同上；不全文件重排或格式化 |
| `ExplorerSpecialView.swift` | 合并 AirDrop 注入与 SMB/卷加载注入；保留收藏、连接取消、挂载读取和 AirDrop 生命周期；关闭窗口同时停止发现并取消所属 SMB 操作 |
| `NativeSmoke.swift` | 保留双方专项入口及所有完整回归调用；按菜单名称执行名称/递减/递增排序，避免新增创建日期后固定下标指向错误动作 |

额外复核自动合并部分：`BrowserController` 使用上游终端偏好，`ExplorerDialogs` 保留单层快捷键滚动及终端选择器，`Views` 保留上游悬停修复，构建脚本保留新网络隐私文案及 Fork/validation 配置。

特殊页面整合增加了防护：AirDrop 页面不生成卷卡片；SMB 忙碌状态不禁用 AirDrop 刷新；晚到卷读取和旧 AirDrop 回调不能覆盖其他页面。新增 4 条跨页面回归使用注入卷读取、SMB 服务与虚构设备，不访问真实共享。关闭通知在主队列中明确主 actor 边界，保持同步停止。

## 最终源码验证

证据目录：`native/output/validation/upstream-merge-20261021/`，保持忽略，不纳入 Git。应用源码、翻译、版本和构建入口共 80 个文件的 SHA-256 清单保存为 `validated-source-manifest.json`，最终复核一致。

| 检查 | 实际结果 | 本地证据 |
| --- | --- | --- |
| 完整核心 `check-core.py` | 12 组共 769 项通过；传输 101、文件操作 231、回收站 59、网络删除 22；不是 XCTest | `core.log` |
| 归档 `check-archives.py` | 压缩/浏览/选择、隔离属性、碰撞、危险路径、链接、损坏、上限及来源保留通过 | `archives.log` |
| 本地化 | 两份目录核对 547 条源字符串，通过 | `localization-final.log` |
| 最终隔离构建 | 原生 1.2.2，`local.macexplorer.native-validation`；严格深度签名校验通过 | `build-delivery.log`、应用 Info.plist |
| 最终完整 AppKit | 557 项通过，1 项 SVN UI 因缺少 `svn`/`svnadmin` 跳过；10,003 项主夹具保持完整 | `smoke/report.json` |
| 普通启动与设置恢复 | 常规启动 3 次通过；创建日期、列配置、SMB 收藏和启动位置的独立恢复子进程均通过 | `smoke/startup-report.json` 及同目录专项报告 |
| 终端 / AirDrop UI | 设置保存、重开与失效终端报错；AirDrop 设备卡片、刷新、失败回退、页面切换、隐藏及窗口关闭通过。设备均为夹具 | `smoke/report.json`、`smoke/terminal-settings-fixture.png` |
| 实际 AirDrop 发现桥接 | 上游 6 项启动/回调/停止/释放检查通过；仅发现，不发送文件 | `airdrop.log` |
| 安装隔离与源码对应 | 两个已安装应用及原应用偏好共 29 个文件/路径散列未变；验收源码清单一致 | `installed-baseline.json`、`delivery-checks.json` |
| 差异检查 | 无残留冲突标记，`git diff --check` 通过；合并提交后核对上游祖先关系及干净工作区 | Git 状态及提交记录 |

构建过程中修正关闭通知的 actor 警告后重新构建，完整 AppKit 使用的是 `build-delivery.log` 对应最终包。核心检查仍会输出已有 API 弃用、Swift 隐式捕获等警告；没有将警告描述为零，也没有因此放宽断言。最终构建成功不是正式签名或公证结果。

## 交付与边界

合并以本地 merge commit 收尾，保留双方提交历史；本轮未 push，未更新远端 main，也未创建 PR。整合前 PR 范围评估保留在 [PR 准备记录](UPSTREAM_PR_READINESS.md)。由于上游已经纳入当前历史，相对本次上游 SHA 不再存在那 5 个未解决的合并冲突；完整功能分支仍包含多个功能和 Fork 专属工具，建议实际向上游投稿时继续拆分。

最终隔离体验包为 `native/output/validation/Mac Explorer.app`。`/Applications/Mac Explorer.app` 和 `/Applications/Mac Explorer Fork.app` 未替换；已安装 Fork 仍为此前 1.1.0，不能把当前 1.2.2 源码验收当作安装升级。

没有重新执行 SMB 传输、网络永久删除、挂载/推出、真实终端启动或 AirDrop 文件发送。已有 SMB 小夹具验收只属于历史基线；本轮通过的是合并后的本地回归和发现桥接。真实断连/写满、服务器落盘、Windows 客户端对照、macOS 13 实机、实际接收方和私有 AirDrop ABI 的未来兼容性仍不在本次结论内。
