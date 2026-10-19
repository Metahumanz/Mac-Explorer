<div align="center">
  <img src="design/icon-selected-mirrored.png" width="96" alt="Mac Explorer 图标">
  <h1>Mac Explorer</h1>
  <p><strong>熟悉的文件管理方式，自然融入 Mac。</strong></p>
  <p>为习惯 Windows 文件资源管理器的你，带来一款原生 Mac 文件管理应用。</p>
  <p>
    <a href="#下载与安装"><strong>一键安装</strong></a> &nbsp;·&nbsp;
    <a href="https://github.com/qixiaoyu27/Mac-Explorer/releases/latest">下载安装包</a> &nbsp;·&nbsp;
    <a href="https://github.com/qixiaoyu27/Mac-Explorer/releases">更新记录</a>
  </p>
  <p><sub>macOS 13 及以上 · Apple Silicon（M 系列）· 免费开源</sub></p>
</div>

<br>

![Mac Explorer 界面预览](docs/images/explorer-light-0.1.53.png)

<p align="center"><sub>图示为早期版本，当前版本界面以实际应用为准。</sub></p>

## 换一台电脑，保留熟悉的习惯

目录树、标签页、地址栏，以及顺手的剪切与粘贴。Mac Explorer 将熟悉的文件管理方式带到 Mac，让查找、整理和移动文件成为连贯的日常操作。它与 Finder 共存，由你选择何时使用。

### 文件之间，从容切换

在多个标签页中打开不同文件夹，沿着目录树浏览，或直接输入路径前往目的地。将常用位置固定到快速访问，也可以从 Finder 导入收藏夹。

### 每个文件夹，都有合适的视图

从大图标到详细列表，八种布局适配照片、文档与工作目录。文件夹可以记住各自的布局和排序；按下空格快速查看文件，减少反复打开应用的打断。

### 常用操作，集中完成

复制、剪切、粘贴、拖放、重命名与撤销，延续熟悉的操作习惯。支持搜索文件、浏览压缩包、解压和创建 ZIP，也能访问 iCloud Drive、外接磁盘与网络共享。

### 按自己的方式使用

浅色、深色或跟随系统，支持简体中文、繁体中文与英文。工具栏和快捷键可以自定义；需要处理代码项目时，也可启用 Git / SVN 集成。

## 下载与安装

适用于 **Apple Silicon（M 系列）Mac，macOS 13 及以上**。

### 一键安装或升级

打开「终端」，粘贴以下命令并回车。已安装的用户请先退出 Mac Explorer，再执行同一命令升级。

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/qixiaoyu27/Mac-Explorer/refs/tags/v1.1.0/scripts/install.sh)"
```

自动下载最新正式版并安装到「应用程序」，安装前校验下载文件，无需 Homebrew 或 sudo。

**首次打开：** 当前版本尚未经过 Apple 公证。如果 macOS 阻止打开，请确认安装包来自本仓库，再前往「系统设置 → 隐私与安全性」允许打开。如果系统明确提示恶意软件，请勿继续运行。首次访问文件夹时，按需授予权限。

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

## 几个顺手的快捷键

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

## 妥善对待你的文件

普通删除会将文件移到系统回收站；复制、移动和解压不会静默覆盖重名文件。文件夹访问权限由 macOS 管理，系统集成功能由你主动开启。

## 反馈与参与

遇到问题，或有希望改进的体验？欢迎 [提交反馈](https://github.com/qixiaoyu27/Mac-Explorer/issues)。请附上应用版本、macOS 版本与复现步骤，并避免上传私人文件。

开发与贡献请参阅 [开发文档](native/README.md) 和 [贡献约定](AGENTS.md)。感谢每一位参与开发、测试和反馈的贡献者。

<details>
<summary>版本策略</summary>

<a id="版本策略"></a>

采用 SemVer：兼容修复更新 PATCH，兼容功能更新 MINOR，不兼容变更更新 MAJOR。版本号仅在正式发布到 GitHub 时更新，日常开发、测试和本地构建不递增；已发布版本、tag 和附件不覆盖。

</details>

---

[GPL-3.0 开源许可](LICENSE) · 界面图标包含 [Lucide artwork（ISC）](native/ICON-LICENSE.txt)
