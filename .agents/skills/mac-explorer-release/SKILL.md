---
name: mac-explorer-release
description: 打包、安装、推送或发布 qixiaoyu27/Mac-Explorer 的 macOS 桌面版本；维护版本号、贡献署名、GitHub Release 与下载附件。仅用于 Mac Explorer 项目。
---

# Mac Explorer 发布

仅处理 `qixiaoyu27/Mac-Explorer`。在仓库根目录执行命令；本机通常位于 `/Users/qi/workplace/Mac Explorer`，以当前工作区和 Git remote 为准。先读仓库 `AGENTS.md`。沿用当前会话对版本、安装、推送和发布的授权；调用此技能本身不授权额外的外部操作。

## 确定发布范围

- 查看 `git status --short`、当前分支、remote、`package.json`、`scripts/release.mjs` 和 `scripts/install.sh`。正式发布前 fetch，核对上次正式 Release、对应 tag、本次提交及已合并 PR。
- 保留无关的脏文件，只提交本次任务文件，禁止 `git add .`。远端有新增提交时先整合，重新判断其对产物的影响；不要直接发布过期构建。
- 使用用户指定的版本；未指定时，修复和小幅调整默认递增 patch。先确认同名 tag / Release 不存在；若已经存在，检查是否为本次未完成流程，按其现状恢复，不能覆盖已发布 tag 或附件。
- 安装、源码推送、正式发布是独立交付。只完成本次授权的部分；已有授权不重复询问。

## 版本与产物

同步修改 `package.json.version`、`package-lock.json.version` 和 `package-lock.json.packages[''].version`，保留原文件格式。版本示例均以变量代替，不能沿用历史版本号。

```sh
release_version=$(node -p 'require("./package.json").version')
release_tag="v$release_version"
release_dir="$PWD/release/adhoc-$release_version"
npm run package:release
```

复用现有脚本，不另造构建流程。脚本会构建前端与原生辅助程序、生成图标，固定使用 ad-hoc 签名，禁用证书自动发现和 Apple 公证，生成并检查以下产物：

- `release/adhoc-版本号/mac-arm64/Mac Explorer.app`
- `Mac-Explorer-版本号-mac-arm64.dmg`
- `Mac-Explorer-版本号-mac-arm64.zip`
- `SHA256SUMS.txt`（DMG 与 ZIP 的 SHA-256）

目标为 Apple Silicon、macOS 13+，以当前构建配置为准。不能把 ad-hoc 签名写成 Developer ID 签名或已公证。构建完成后若又改了会进入应用的代码或版本元数据，必须重建产物。

## 发布前检查（内部执行）

“发布说明不写验证”只约束公开文案，不省略必要检查。

- 使用本次改动已有的单元测试及相关 smoke；同一源码已通过的检查无需机械重跑。新代码、合并变更或失败需要针对性复查。
- 确认最终打包版的相关路径可用。已有 smoke 支持通过 `EXPLORER_APP_PATH` 指定应用可执行文件；不要用开发版结果代替打包版结果。
- 涉及系统剪贴板的测试串行执行。文件操作限临时目录；真实第三方应用测试与原生格式夹具测试分别记录，不能互相冒充。需要显示窗口的测试避免与手动操作同时进行。
- 检查应用版本、应用及 DMG 签名、校验清单。保留失败信息并查明原因后恢复流程，不能隐藏失败后直接宣称通过。

## 按需安装本机

仅在会话已要求安装／更新本机时执行。默认目标 `/Applications/Mac Explorer.app`，先检查实际安装位置和 bundle identifier；旧个人目录安装以当前安装脚本的迁移逻辑为准。

1. 正常退出应用并保留窗口，确认主进程已退出；不得直接替换正在运行的应用。
2. 记录用户偏好文件的哈希，安装后确认未改动。配置目录通常为 `~/Library/Application Support/Mac Explorer`；`window-state.json` 会随退出正常变化，不要求哈希不变。
3. 使用已有离线安装入口，复用签名、版本、SHA-256、原子替换与失败恢复逻辑：

```sh
MAC_EXPLORER_PREPARED_UPDATE="$release_dir" \
MAC_EXPLORER_INSTALL_DIR=/Applications \
MAC_EXPLORER_NO_OPEN=1 /bin/bash scripts/install.sh
```

安装脚本对同版本会跳过，不得把跳过当作已替换。本地修改版通常通过本次版本递增解决。不要擅自清空偏好、关闭 Gatekeeper 或移除隔离标记。

安装后核对安装版与发布产物 `Contents/Resources/app.asar` 哈希、签名及版本；执行与本次改动相关的安装版检查，重新启动日常应用。

## 提交与推送

核对暂存区，提交本次任务与版本元数据。正式发布创建 annotated tag，再原子推送当前提交到正式发布分支及 tag。当前项目正式分支为 `main`；若实际分支不同，先确保正式分支包含全部发布内容，不能将未经整合的功能分支直接当作正式版本。

```sh
git tag -a "$release_tag" -m "Mac Explorer $release_tag"
git push --atomic origin main "$release_tag"
```

如果只授权推送，到此结束，不创建 Release。若 push 失败，先核对远端，禁止强制推送或移动已存在的 tag。核对 tag 最终指向的提交与用于构建的源码一致。

## 发布说明

使用中文、面向用户描述本次实际变化。不要添加“验证”章节，也不列测试数量、回归项目、夹具细节或未实测应用清单。实际阻塞或影响用户使用的限制仍需如实说明。

建议结构如下；没有额外贡献者时省略该章节：

```markdown
### 更新内容

- 用户可感知的变化。（贡献署名）

### 贡献者

感谢实际核实的反馈或其他贡献，链接对应 issue 与作者。

### 下载与安装

Apple Silicon（M 系列）· macOS 13+。默认安装到 `/Applications/Mac Explorer.app`，保留偏好设置。

附件提供 DMG、ZIP 和 SHA256SUMS.txt。使用 ad-hoc 临时签名，未经 Apple 公证；链接本次 tag 下 README 的安装说明。
```

- 每个更新项就地署名。PR 使用 `（[#编号](PR链接)，[@作者](作者链接)）`；无 PR 的直接提交使用 `（[@作者](作者链接)，[短哈希](提交链接)）`。
- 从上次正式版本到本次 tag 的 commits / merged PR 核实作者；不能只署名合并人，不重复算旧贡献，不虚构 PR 编号。
- 反馈者放单独的“贡献者”段落，不能写成代码作者。
- 如提供命令行安装示例，将 raw installer URL 固定到本次 `refs/tags/v版本/scripts/install.sh`。安装脚本仍按官方 latest 校验清单选择最新安装包，不应声称这是强制安装某历史版本的入口。

## GitHub Release

先将完整说明写到临时 UTF-8 文件，再通过 `--notes-file` 传入，避免 shell 展开或转义破坏文案。不要使用自动生成说明覆盖贡献署名。

```sh
gh release create "$release_tag" \
  "$release_dir/Mac-Explorer-$release_version-mac-arm64.dmg" \
  "$release_dir/Mac-Explorer-$release_version-mac-arm64.zip" \
  "$release_dir/SHA256SUMS.txt" \
  --repo qixiaoyu27/Mac-Explorer --verify-tag --draft \
  --title "$release_tag · 本次变化概述" --notes-file /tmp/mac-explorer-release-notes.md
```

核对草稿正文、署名链接和三个附件的名称、上传状态、大小、SHA-256 digest 与本地产物一致后再发布。草稿按 tag 查询 REST endpoint 可能返回 404；用 `gh release view` 或 release 列表／ID 检查，不能因此重复创建。

```sh
gh release edit "$release_tag" --repo qixiaoyu27/Mac-Explorer --draft=false --latest
gh release view "$release_tag" --repo qixiaoyu27/Mac-Explorer \
  --json tagName,isDraft,isPrerelease,body,url,assets
```

发布后重新打开 Release，确认保存的说明和署名链接正确，且为正式 latest。匿名读取官方 latest API，实际下载公开的 DMG、ZIP 和校验文件，对比本地与公开附件哈希；核对本次 tag 下 installer 与源码一致。失败时修复并复查，不能用“上传成功”代替“下载可用”。

恢复被中断的流程时先查看 tag、Release 的 draft 状态及已上传附件。正式版本已存在时按实际状态继续核对，不重复发布、不覆盖已有附件。完成后简短告知版本、Release 链接及已授权交付状态；只补充影响用户的实际限制。
