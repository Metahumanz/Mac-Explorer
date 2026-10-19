<div align="center">
  <img src="design/icon-selected-mirrored.png" width="88" alt="Mac Explorer 图标">
  <h1>Mac Explorer</h1>
  <h3>熟悉的操作，Mac 的体验。</h3>
  <p>一款原生 macOS 文件管理器，延续 Windows 文件资源管理器的使用习惯。<br>浏览、整理、预览，让日常文件操作一气呵成。</p>
  <p>
    <a href="#下载与安装"><strong>一键安装</strong></a> &nbsp;·&nbsp;
    <a href="#日常所需触手可及">功能一览</a> &nbsp;·&nbsp;
    <a href="https://github.com/qixiaoyu27/Mac-Explorer/releases">更新记录</a>
  </p>
  <p><sub>macOS 13 及以上 · Apple Silicon（M 系列）· 免费开源</sub></p>
</div>

<br>

![Mac Explorer 界面预览](docs/images/explorer-light-0.1.53.png)

<p align="center"><sub>图示为早期版本，当前版本界面以实际应用为准。</sub></p>

## 下载与安装

**一条命令，完成安装与升级。**

打开「终端」，粘贴并执行以下命令。升级前请先退出应用。

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/qixiaoyu27/Mac-Explorer/refs/tags/v1.1.0/scripts/install.sh)"
```

自动获取最新正式版，校验后安装到「应用程序」。无需 Homebrew 或 sudo。

<sub>支持 macOS 13 及以上 · Apple Silicon（M 系列）</sub>

> **首次打开**
> 当前版本尚未经过 Apple 公证。若 macOS 阻止打开，请确认下载来源为本仓库，再到「系统设置 → 隐私与安全性」允许打开。若系统明确提示恶意软件，请勿继续运行。

**后续更新：** 再次执行上方命令，或在「设置 → 关于」中检查更新。

<details>
<summary>也可以手动安装 DMG</summary>

1. 前往 [下载页面](https://github.com/qixiaoyu27/Mac-Explorer/releases/latest)，选择 **DMG** 安装包。
2. 打开 DMG，将 **Mac Explorer** 拖入 **Applications（应用程序）**。更新时请先退出旧版本。
3. 打开应用，按需允许访问桌面、文稿或下载文件夹。

</details>

<details>
<summary>从早期版本升级</summary>

从早期 Electron 版升级时，请使用上方安装命令或手动安装 DMG。旧版应用内更新器无法自动完成此次迁移。

个人文件不受影响。外观、快捷键和窗口会话等偏好需要重新设置；收藏夹可通过「设置 → 常规 → 从 Finder 导入收藏夹」重新导入。

</details>

## 日常所需，触手可及

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>浏览，有条不紊</h3>
      <p>多标签、目录树与路径导航，让不同文件夹之间的切换更直接。常用位置固定到快速访问，Finder 收藏夹也可导入。</p>
    </td>
    <td width="50%" valign="top">
      <h3>查看，恰到好处</h3>
      <p>八种视图，从大图标到详细列表。每个文件夹记住自己的布局与排序，按下空格即可快速预览。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>整理，顺手完成</h3>
      <p>剪切、粘贴、拖放、重命名与撤销。搜索文件、浏览压缩包、解压或创建 ZIP，在同一个窗口中完成。</p>
    </td>
    <td width="50%" valign="top">
      <h3>习惯，由你定义</h3>
      <p>浅色与深色外观，三种界面语言，自定义工具栏和快捷键。连接 iCloud Drive、外接磁盘与网络共享，也支持 Git / SVN。</p>
    </td>
  </tr>
</table>

<br>

### 与 Finder 共存，按你的习惯使用

Mac Explorer 不替换 Finder。文件夹权限由 macOS 管理，系统集成由你主动开启。普通删除进入系统回收站，复制、移动与解压不会静默覆盖重名文件。

<details>
<summary>常用快捷键</summary>

| 操作 | 快捷键 |
| --- | --- |
| 复制 / 剪切 / 粘贴 | ⌘C / ⌘X / ⌘V |
| 新建标签页 | ⌘T |
| 前往文件夹 | ⇧⌘G |
| 搜索 | ⌘F |
| 重命名 | Return 或 F2 |
| 快速查看 | Space |
| 移到回收站 | ⌘⌫ |
| 打开设置 | ⌘, |

更多操作与自定义选项可在应用菜单和设置中查看。

</details>

## 反馈与参与

每一份认真反馈，都让日常使用更顺手。欢迎 [报告问题或提出建议](https://github.com/qixiaoyu27/Mac-Explorer/issues)，请附上应用与 macOS 版本、复现步骤，并隐去私人信息。

开发与贡献请参阅 [开发文档](native/README.md) 和 [贡献约定](AGENTS.md)。感谢每一位参与开发、测试和反馈的贡献者。

<details>
<summary>版本策略</summary>

<a id="版本策略"></a>

采用 SemVer：兼容修复更新 PATCH，兼容功能更新 MINOR，不兼容变更更新 MAJOR。版本号仅在正式发布到 GitHub 时更新，日常开发、测试和本地构建不递增；已发布版本、tag 和附件不覆盖。

</details>

---

[GPL-3.0 开源许可](LICENSE) · 界面图标包含 [Lucide artwork（ISC）](native/ICON-LICENSE.txt)
