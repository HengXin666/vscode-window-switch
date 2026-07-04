# Window Deck

Window Deck 是一个 VS Code 多窗口导航器。它不会交换 workspace、重开文件夹、迁移终端或触碰 debug session。它只注册已经打开的 VS Code 窗口，为它们提供可重命名、可上色、可点击切换的导航页面，并请求操作系统聚焦目标窗口。

## 功能

- 每个 VS Code 窗口都会注册到本机 registry，并通过心跳检测失联窗口。
- 状态栏或编辑器标题区右上角按钮会打开原生窗口下拉列表。
- 可选安装非官方顶部栏补丁，在 VS Code 标题栏插入 `Window Deck ▾`，点击后显示自绘下拉菜单。
- 高级管理面板中用浏览器标签页风格展示窗口：`#颜色 <窗口标题>`。
- 左键点击标签只做切换；失联窗口左键点击会尝试重新打开 workspace。
- 右键标签可以重命名、设置颜色、删除记录。
- 失联空窗口会自动从 registry 移除。
- 可以拖拽标签同步排序；拖到另一个标签上会创建分组。
- 分组可以折叠，也可以取消分组。
- 支持本地、SSH、WSL、Dev Container、Codespaces 和未知远程窗口识别。
- 窗口列表会按顺序展示每个窗口内的终端状态：运行中、等待输入、空闲。
- 聚焦能力：
  - macOS：默认写入 workspace 级 `window.title` 标记，并通过 AppleScript best-effort 匹配窗口标题。
  - Linux X11：安装 `wmctrl` 或 `xdotool` 后可聚焦。
  - Linux Wayland KDE：通过 `qdbus6` 或 `qdbus` 调用 KWin 脚本接口。
  - 其他 Wayland 桌面：仍可索引、重命名和上色，但自动聚焦受系统限制。
- `Window Deck: 清理失联窗口` 可以清理旧窗口记录。
- `Window Deck: 诊断聚焦支持` 可以查看当前平台聚焦能力。

## Development

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

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

Automatic OS focusing is best-effort in this MVP. VS Code exposes `window.title` as configuration rather than a per-window runtime title API, so Window Deck does not automatically write a unique token into global settings.

On KDE Wayland, install Qt D-Bus tools so `qdbus6` or `qdbus` is available. Window Deck then asks KWin to focus a matching VS Code window by title. This remains best-effort because KWin controls the final activation behavior.

On macOS, Window Deck automatically writes a workspace-level `window.title` marker by default so AppleScript can match windows reliably. Disable this with `windowDeck.autoApplyTitleMarkerOnMacOS`.

On KDE Wayland, Window Deck automatically writes a workspace-level `window.title` marker by default so KWin can match windows reliably. Disable this with `windowDeck.autoApplyTitleMarkerOnKdeWayland`.

After installing or updating Window Deck, it prompts once per extension version to reload the current VS Code window so the bridge server, title marker, and window registry run the same extension version.
