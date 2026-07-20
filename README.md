# Window Deck

Window Deck 是一个 VS Code 多窗口导航器。它不会交换 workspace、重开文件夹、迁移终端或触碰 debug session。它只注册已经打开的 VS Code 窗口，为它们提供可重命名、可上色、可点击切换的导航页面，并请求操作系统聚焦目标窗口。

## 功能

- 每个 VS Code 窗口都会注册到本机 registry，并通过心跳检测失联窗口。
- 窗口 ID、别名、颜色、排序和分组只保存在 VS Code 扩展全局存储中，不会创建或修改项目的 `.vscode/settings.json`。
- Activity Bar 中提供“同步终端”图标，侧栏直接显示窗口列表；右键视图标题仍可打开窗口列表或高级管理面板。命令面板中的 `Window Deck: 显示窗口列表` 仍提供原生快速选择列表。
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
  - `合并终端` 使用占满编辑器可用区域的“左侧窗口 / 中间同步视图 / 右侧所选窗口终端”三栏布局，页面本身不会滚动，窗口列表、输出和终端列表分别独立滚动；左右看板可拖动分隔条调整宽度。
  - 合并终端页中的窗口和终端点击只改变页面内的展示对象，不会打开或聚焦其他 VS Code 窗口；窗口跳转统一由 `快速切换` 完成。
  - 中间区域使用 xterm.js 渲染真实终端 PTY 的原始 VT 数据，支持实时光标、颜色、TUI、Zsh 插件输出和滚动；合并页输入会通过 `Terminal.sendText` 写回原终端，不会聚焦所属窗口，也不会使用 tmux。
  - 实时原始数据依赖 VS Code 的 `terminalDataWriteEvent` proposed API。扩展启动时会自动检查本机 `product.json` 的共享权限并同步 manifest；已安装过权限的用户更新或重装扩展后不需要再次手动输入命令。首次安装或 VS Code 更新覆盖权限时，执行 `Window Deck: 安装原生终端同步权限` 一次即可，Linux 使用 pkexec，macOS 使用系统管理员授权，Windows 使用 UAC 提权。远程 workspace 不要求远端扩展单独安装，UI 扩展会在本地窗口接收远程终端事件。
  - 左下角状态栏按钮只打开轻量的快速窗口选择；需要分组、排序、改色和终端合并视图时，再从命令面板执行 `Window Deck: 打开高级管理面板`。
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
