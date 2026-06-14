# Window Deck

Window Deck 是一个 VS Code 多窗口导航器。它不会交换 workspace、重开文件夹、迁移终端或触碰 debug session。它只注册已经打开的 VS Code 窗口，为它们提供可重命名、可上色、可点击切换的导航页面，并请求操作系统聚焦目标窗口。

## 功能

- 每个 VS Code 窗口都会注册到本机 registry，并通过心跳检测失联窗口。
- 状态栏或编辑器标题区右上角按钮可以打开可固定的 Window Deck 编辑器页。
- 编辑器页中用浏览器标签页风格展示窗口：`#颜色 <窗口标题>`。
- 点击标签切换窗口；失联窗口点击标题会尝试重新打开 workspace。
- 失联窗口显示 `x`，点击后删除记录。
- 可以直接在标签里重命名。
- 可以点击颜色按钮展开自绘颜色菜单。
- 可以拖拽标签同步排序；拖到另一个标签上会创建分组。
- 分组可以折叠，也可以取消分组。
- 支持本地、SSH、WSL、Dev Container、Codespaces 和未知远程窗口识别。
- 聚焦能力：
  - macOS：通过 AppleScript best-effort 匹配窗口标题。
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

## Release

The GitHub workflow in `.github/workflows/release.yml` packages the extension on pushes to `main`, creates or updates a tag named after `package.json` version, and uploads the `.vsix` file to a GitHub Release.

Before publishing, update these fields in `package.json`:

- `publisher`
- `repository.url`

The workflow needs the repository setting `Actions: Read and write permissions` enabled so `GITHUB_TOKEN` can create tags and releases.

## Notes

Automatic OS focusing is best-effort in this MVP. VS Code exposes `window.title` as configuration rather than a per-window runtime title API, so Window Deck does not automatically write a unique token into global settings.

On KDE Wayland, install Qt D-Bus tools so `qdbus6` or `qdbus` is available. Window Deck then asks KWin to focus a matching VS Code window by title. This remains best-effort because KWin controls the final activation behavior.

On KDE Wayland, Window Deck automatically writes a workspace-level `window.title` marker by default so KWin can match windows reliably. Disable this with `windowDeck.autoApplyTitleMarkerOnKdeWayland`.
