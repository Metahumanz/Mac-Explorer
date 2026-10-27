# 本地网络删除版本

- 分支：`codex/local-network-delete`；基于上游 v1.5.0（`1aa67b6`）。
- 本地版本：1.6.1；未发布 GitHub Release。
- 网络永久删除必须确认，默认取消；本地删除仍进回收站，保留批量行为。

## SMB 句柄删除

保留实际父目录 FD 分类、FSID、身份和确认清单。连接挂载会话的实际数值端点，复用独立 SMB 登录及钥匙串账号；删除登录只有登录和取消，不提供普通传输或路径删除回退。

先绑定祖先目录和全部确认对象，DELETE 打开句柄拒绝共享写入/删除，使用 OPEN_EXISTING 和 OPEN_REPARSE_POINT，不在 CREATE 时标记删除。通过同一句柄核对 File ID、类型、创建/修改时间及大小；直接通过目录句柄枚举名称和 File ID，避免只依赖挂载缓存。登录后再次核对本地清单。

按后序对相同 FileId 提交 SET_INFO / FileDispositionInformation 和 CLOSE。生产构建没有 NetworkDeletion 的 unlinkat 路径。新增项不纳入删除，非空目录拒绝删除。取消在不可逆请求前生效；一旦提交删除标记则处理 CLOSE 结果。响应丢失报告结果未知并停止整个批次，不重新连接或按路径重试；保留未确认的选择和剪贴板，清空 redo，记录已确认的部分数量。

## 边界

- 每个所选根最多 256 个清单节点（包括根），以便同时持有句柄。超限不退化；原有全批准备预算仍为 50,000 节点、16 MiB 路径及 128 层。
- 符号链接/重解析点、同一清单中的重复文件身份（硬链接）、NFS/未知挂载、子目录/DFS 挂载及无法对应 File ID 的服务器均拒绝操作。
- 共享模式只约束遵守 SMB 的访问。NAS 本机程序、其他协议或服务端实现缺陷仍可能绕过它，不能宣称整个目录原子删除或任意 NAS 上绝对安全。确认框保留此风险。
- 成功数量表示服务器确认删除请求；其他允许删除共享的打开句柄可能延后最终文件回收，不表示数据已物理擦除。
- 不增加内容读取/哈希、NAS 备份、隔离目录、自动回滚、chmod 或强制删除。

## 隔离验证（2026-10-27）

- NetworkDeletionChecks：59 条断言；旧 POSIX KNOWN LIMIT 仅在本地临时夹具复现，不进入生产删除路径。普通 API 编译边界 3 项通过。
- FileActionChecks 231、TrashChecks 59、ServerSideTransferChecks 59 通过。
- 独立回环 SMB 删除协议：26 项通过；真实 C 客户端连接独立服务器，夹具明确建模句柄身份，不能据此证明 NAS 内部实现原子安全。
- 既有回环服务端复制：35 项通过。
- 完整隔离 UI smoke：646 条结果，passed/fixturePreserved 均为 true；缺少 svn/svnadmin 的 SVN UI 跳过。
- 英文及繁中文案：595 条源字符串通过。

复现使用 `native/scripts/check-core.py`、`build.py --validation` 和 `smoke.py --validation --skip-build`。协议检查使用单独虚拟环境安装 `native/scripts/smb-test-requirements.txt`，执行 `check-smb-handle-delete.py` 与 `check-smb-server-copy.py`。

本轮测试只使用本地临时目录和 127.0.0.1，没有挂载或修改真实 NAS。macOS 13 实机与真实 NAS 多客户端删除仍待验收。

## 安装和更新

沿用原生离线安装入口校验 ZIP SHA-256、签名、架构和版本，并原子替换 `/Applications/Mac Explorer.app`。安装前正常退出并保留窗口，安装后核对偏好和程序哈希。

这是本地定制构建。官方更新可能覆盖本功能；版本号不高于 1.6.1 的官方包不会自动替换此版本。

Installed production verification: 616 UI results, passed, temporary fixture preserved. The validation-only network injection and unavailable SVN tools were skipped. Installed executable hash matches the ZIP; arm64 and strict signature verification passed, and daily preferences were unchanged before relaunch.
