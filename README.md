# Window Deck

Window Deck 是一个 VS Code 多窗口导航器。它不会交换 workspace、重开文件夹、迁移终端或触碰 debug session。它只注册已经打开的 VS Code 窗口，为它们提供可重命名、可上色、可点击切换的导航页面，并请求操作系统聚焦目标窗口。

## 功能

- 每个 VS Code 窗口都会注册到本机 registry，并通过心跳检测失联窗口。
- 窗口 ID、别名、颜色、排序和分组只保存在 VS Code 扩展全局存储中，不会创建或修改项目的 `.vscode/settings.json`。
- 状态栏或编辑器标题区右上角按钮会打开完整窗口与命令行管理界面；命令面板中的 `Window Deck: 显示窗口列表` 仍提供原生快速选择列表。
- 可选安装非官方顶部栏补丁，在 VS Code 标题栏插入 `Window Deck ▾`，点击后显示自绘下拉菜单。
- 高级管理面板中用浏览器标签页风格展示窗口：`#颜色 <窗口标题>`。
- 左键点击标签只做切换；失联窗口左键点击会尝试重新打开 workspace。
- 右键标签可以重命名、设置颜色、删除记录。
- 失联空窗口会自动从 registry 移除。
- 可以拖拽标签同步排序；拖到另一个标签上会创建分组。
- 分组可以折叠，也可以取消分组。
- 支持本地、SSH、WSL、Dev Container、Codespaces 和未知远程窗口识别。
- 终端栏目分为两个标签页：
  - `快速切换` 只负责窗口切换；它会只读展示每个窗口的终端名称、命令和活动状态，终端标签不能预览或操作。
  - `合并终端` 使用“左侧窗口 / 中间原生终端 / 右侧当前窗口终端”三栏布局。左侧切换窗口，右侧切换该窗口内的终端，中间入口直接打开 VS Code 原生终端，输入、输出、快捷键、复制和搜索等能力均由原生终端提供。
- 聚焦能力：
  - 所有 VS Code 桌面平台：有 workspace 的窗口优先使用 VS Code 自身的跨平台窗口路由，不需要系统辅助功能权限或额外命令。
  - macOS 空窗口：使用 AppleScript best-effort fallback。
  - Linux X11 空窗口：使用 `wmctrl` 或 `xdotool` fallback。
  - Linux Wayland KDE 空窗口：通过 `qdbus6` 或 `qdbus` 调用 KWin 脚本 fallback。
  - 其他 Wayland 桌面的空窗口：仍可索引、重命名和上色，但自动聚焦受系统限制。
- `Window Deck: 清理失联窗口` 可以清理旧窗口记录。
- `Window Deck: 诊断聚焦支持` 可以查看当前平台聚焦能力。
- 默认每 24 小时检查 GitHub Release；发现新版本后可直接下载并安装 VSIX。
- 更新安装完成后可一键重载所有已打开的 VS Code 窗口。
- 手动检查更新：打开 `Window Deck: 打开高级管理面板`，点击右上角“检查更新”；也可以在命令面板运行 `Window Deck: 检查更新`。

## Development

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

## Reusable updater

The sibling project `../vscode-extension-github-updater/` is a standalone, reusable module for other VS Code extensions. It provides GitHub Release checks, VSIX download/installation, and the post-update “reload all windows” workflow. Its compiled runtime is copied into `dist/vendor` by the build process.

## 顶部栏补丁

VS Code 稳定扩展 API 不能在原生文件标签栏或标题栏中插入自绘组件。Window Deck 提供一个本机优先的非官方补丁，把脚本注入到 VS Code workbench。

安装：

```bash
sudo bash scripts/install-workbench-patch.sh
```

卸载：

```bash
sudo bash scripts/uninstall-workbench-patch.sh
```

安装或卸载后需要重启 VS Code。VS Code 更新后可能覆盖 `workbench.html`，需要重新安装补丁。

## Release

The GitHub workflow in `.github/workflows/release.yml` packages the extension on pushes to `main`, creates or updates a tag named after `package.json` version, and uploads the `.vsix` file to a GitHub Release.

Before publishing, update these fields in `package.json`:

- `publisher`
- `repository.url`

The workflow needs the repository setting `Actions: Read and write permissions` enabled so `GITHUB_TOKEN` can create tags and releases.

## Notes

Window Deck first asks VS Code's main process to route an already-open workspace to its existing window. Platform-specific OS focusing is only a best-effort fallback for empty windows, which do not have a workspace URI.

Window metadata is stored under the extension's `globalStorageUri`. Version 0.6.0 also removes legacy Window Deck `window.title` values; if the generated `.vscode/settings.json` and `.vscode` directory become empty, they are removed safely.

On KDE Wayland, install Qt D-Bus tools so `qdbus6` or `qdbus` is available for empty-window fallback. This remains best-effort because KWin controls the final activation behavior.

On macOS, normal workspace switching does not modify `window.title` and does not require Accessibility permission.

Automatic update checks use the latest GitHub Release and run at most once every 24 hours. They can be disabled with `windowDeck.autoCheckUpdates`, or triggered manually with `Window Deck: 检查更新`.
