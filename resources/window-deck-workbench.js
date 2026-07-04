(function () {
  const BRIDGE = "http://127.0.0.1:39417";
  const COLORS = ["#4f8cff", "#2fb344", "#f59f00", "#e03131", "#9c36b5", "#0ca678", "#f76707", "#495057"];
  let state = { windows: [], layout: { order: [], groups: [] }, currentWindowId: "" };
  let open = false;
  let dragState = null;
  let lastCommandSeq = -1;
  const scriptStartedAt = Date.now();

  const style = document.createElement("style");
  style.textContent = `
    .window-deck-root { position: relative; display: flex; align-items: center; height: 100%; margin-left: 6px; z-index: 1000; }
    .window-deck-button { height: 24px; padding: 0 8px; border: 1px solid var(--vscode-commandCenter-inactiveBorder, transparent); border-radius: 4px; color: var(--vscode-titleBar-activeForeground); background: transparent; cursor: pointer; font: 12px var(--monaco-monospace-font, sans-serif); }
    .window-deck-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .window-deck-overlay { position: fixed; inset: 0; z-index: 999998; display: none; pointer-events: none; }
    .window-deck-overlay.open { display: block; }
    .window-deck-popup { position: absolute; top: 34px; right: 10px; width: min(620px, calc(100vw - 20px)); max-height: min(560px, calc(100vh - 60px)); overflow: auto; padding: 6px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); box-shadow: 0 12px 34px rgba(0,0,0,.38); pointer-events: auto; opacity: 0; transform: translateY(-6px) scale(.985); transition: opacity .12s ease, transform .12s ease; }
    .window-deck-overlay.open .window-deck-popup { opacity: 1; transform: translateY(0) scale(1); }
    .window-deck-section { padding: 7px 6px 3px; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; }
    .window-deck-row { display: grid; grid-template-columns: 12px minmax(0, 1fr) minmax(0, auto) auto; gap: 8px; align-items: center; min-height: 32px; padding: 5px 7px; margin: 2px 0; border: 1px solid transparent; border-radius: 5px; background: transparent; cursor: pointer; user-select: none; transition: transform .14s ease, background-color .12s ease, opacity .12s ease, box-shadow .12s ease, outline-color .12s ease; }
    .window-deck-row:hover { background: var(--vscode-list-hoverBackground); }
    .window-deck-row.current { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .window-deck-row.stale { opacity: .62; }
    .window-deck-row.dragging, .window-deck-group.dragging { opacity: .42; transform: scale(.985); }
    .window-deck-box { width: 12px; height: 12px; border-radius: 2px; border: 1px solid color-mix(in srgb, var(--wd-color), #000 18%); background: var(--wd-color); box-sizing: border-box; }
    .window-deck-title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
    .window-deck-meta { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; margin-left: 7px; }
    .window-deck-terminals { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; min-width: 0; max-width: 120px; }
    .window-deck-terminal { --wd-terminal-color: var(--vscode-descriptionForeground); display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 18px; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--wd-terminal-color), transparent 58%); border-radius: 4px; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--wd-terminal-color), transparent 88%); font-size: 10px; line-height: 18px; }
    .window-deck-terminal.running { --wd-terminal-color: #3fb950; }
    .window-deck-terminal.waitingInput { --wd-terminal-color: #d29922; }
    .window-deck-terminal.idle { --wd-terminal-color: var(--vscode-descriptionForeground); opacity: .78; }
    .window-deck-terminal svg { flex: 0 0 12px; width: 12px; height: 12px; color: var(--wd-terminal-color); }
    .window-deck-rename { width: 100%; min-height: 24px; box-sizing: border-box; border: 1px solid var(--vscode-focusBorder); border-radius: 4px; padding: 2px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
    .window-deck-icon { width: 22px; height: 22px; border: 0; border-radius: 4px; color: inherit; background: transparent; cursor: pointer; line-height: 20px; }
    .window-deck-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    .window-deck-group { margin: 3px 0; border: 1px solid var(--vscode-widget-border); border-radius: 5px; overflow: hidden; background: var(--vscode-dropdown-background); transition: transform .14s ease, outline-color .12s ease, box-shadow .12s ease, opacity .12s ease; }
    .window-deck-group-head { display: grid; grid-template-columns: 18px 12px minmax(0, 1fr) auto; gap: 7px; align-items: center; min-height: 30px; padding: 4px 7px; background: var(--vscode-sideBar-background); cursor: pointer; user-select: none; }
    .window-deck-group-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .window-deck-group.collapsed .window-deck-group-body { display: none; }
    .window-deck-group-body { padding: 3px 4px 4px; }
    .window-deck-drop-before { box-shadow: 0 -2px 0 var(--vscode-focusBorder); transform: translateY(2px); }
    .window-deck-drop-merge, .window-deck-drop-into { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; background: var(--vscode-list-hoverBackground); }
    .window-deck-menu { position: fixed; min-width: 188px; padding: 5px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; background: var(--vscode-dropdown-background); box-shadow: 0 8px 24px rgba(0,0,0,.35); z-index: 1000000; display: none; pointer-events: auto; }
    .window-deck-menu.open { display: block; }
    .window-deck-menu button { display: block; width: 100%; min-height: 27px; padding: 4px 8px; border: 0; border-radius: 4px; color: var(--vscode-dropdown-foreground); background: transparent; text-align: left; cursor: pointer; }
    .window-deck-menu button:hover { background: var(--vscode-list-hoverBackground); }
    .window-deck-palette { display: grid; grid-template-columns: repeat(8, 18px); gap: 5px; padding: 6px 4px 3px; }
    .window-deck-swatch { width: 18px !important; min-height: 18px !important; padding: 0 !important; border: 1px solid var(--vscode-contrastBorder) !important; border-radius: 3px !important; background: var(--wd-color) !important; }
    .window-deck-empty { padding: 12px; color: var(--vscode-descriptionForeground); }
    @media (max-width: 560px) {
      .window-deck-row { grid-template-columns: 12px minmax(0, 1fr) auto; }
      .window-deck-row > .window-deck-terminals { grid-column: 2 / span 2; grid-row: 2; justify-content: flex-start; max-width: none; }
      .window-deck-row > span:last-child { grid-column: 3; grid-row: 1; }
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.className = "window-deck-root";
  root.innerHTML = '<button class="window-deck-button" title="Window Deck">Window Deck ▾</button>';

  const overlay = document.createElement("div");
  overlay.className = "window-deck-overlay";
  overlay.innerHTML = '<div class="window-deck-popup"></div><div class="window-deck-menu"></div>';
  document.body.appendChild(overlay);

  function mount() {
    if (document.querySelector(".window-deck-root")) return true;
    const target = document.querySelector(".part.titlebar .titlebar-right") ||
      document.querySelector(".part.titlebar .window-controls-container") ||
      document.querySelector(".part.titlebar") ||
      document.querySelector(".tabs-and-actions-container .editor-actions") ||
      document.querySelector(".tabs-and-actions-container");
    if (!target) return false;
    target.prepend(root);
    root.querySelector(".window-deck-button").addEventListener("click", event => {
      event.stopPropagation();
      toggleOverlay();
    });
    document.addEventListener("click", event => {
      if (open && !overlay.querySelector(".window-deck-popup").contains(event.target) && !root.contains(event.target)) closeOverlay();
    }, true);
    return true;
  }

  const mountTimer = setInterval(() => {
    if (mount()) clearInterval(mountTimer);
  }, 500);

  async function toggleOverlay() {
    if (open) {
      closeOverlay();
      return;
    }
    await refresh();
    open = true;
    render();
  }

  function closeOverlay() {
    open = false;
    closeMenu();
    overlay.classList.remove("open");
  }

  async function refresh() {
    try {
      const res = await fetch(`${BRIDGE}/state`);
      if (!res.ok) return;
      state = await res.json();
      state.layout = normalizeLayout(state.layout || { order: [], groups: [] });
    } catch {}
  }

  async function pollCommand() {
    try {
      const res = await fetch(`${BRIDGE}/command`);
      if (!res.ok) return;
      const command = await res.json();
      if (lastCommandSeq < 0) {
        lastCommandSeq = command.seq || 0;
        if ((command.issuedAt || 0) >= scriptStartedAt && command.seq > 0) {
          await toggleOverlay();
          acknowledgeOverlay(command.seq);
        }
        return;
      }
      if (command.seq > lastCommandSeq) {
        lastCommandSeq = command.seq;
        await toggleOverlay();
        acknowledgeOverlay(command.seq);
      }
    } catch {}
  }

  async function action(payload) {
    await fetch(`${BRIDGE}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
    await refresh();
    render();
  }

  function acknowledgeOverlay(seq) {
    fetch(`${BRIDGE}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "overlayAck", seq })
    }).catch(() => {});
  }

  function render() {
    overlay.classList.toggle("open", open);
    if (!open) return;
    state.layout = normalizeLayout(state.layout || { order: [], groups: [] });
    const popup = overlay.querySelector(".window-deck-popup");
    const html = renderSection(false) + renderSection(true);
    popup.innerHTML = html || '<div class="window-deck-empty">没有已注册的工作区窗口</div>';
    bind(popup);
  }

  function renderSection(stale) {
    const entries = buildEntries(stale);
    if (!entries.length) return "";
    return `<div class="window-deck-section">${stale ? "历史关闭" : "已打开"}</div>${entries.join("")}`;
  }

  function buildEntries(stale) {
    const byId = new Map((state.windows || []).map(w => [w.windowId, w]));
    const grouped = new Set((state.layout.groups || []).flatMap(g => g.windowIds));
    const out = [];
    for (const id of state.layout.order || []) {
      const group = (state.layout.groups || []).find(g => g.windowIds[0] === id);
      if (group) {
        const items = group.windowIds.map(windowId => byId.get(windowId)).filter(Boolean);
        if (items.length && items.every(item => item.stale) === stale) out.push(renderGroup(group, items));
        continue;
      }
      const item = byId.get(id);
      if (item && !grouped.has(id) && item.stale === stale) out.push(renderRow(item));
    }
    return out;
  }

  function renderGroup(group, items) {
    const title = group.title || items.map(item => item.title).join(" / ") || "分组";
    const color = group.color || (items[0] && items[0].color) || "#4f8cff";
    return `<section class="window-deck-group ${group.collapsed ? "collapsed" : ""}" data-group-id="${esc(group.id)}" draggable="true">
      <div class="window-deck-group-head" data-group-id="${esc(group.id)}">
        <button class="window-deck-icon" data-collapse="${esc(group.id)}">${group.collapsed ? "›" : "⌄"}</button>
        <span class="window-deck-box" style="--wd-color:${esc(color)}"></span>
        <span class="window-deck-group-title" data-group-title="${esc(group.id)}">${esc(title)}</span>
        <button class="window-deck-icon" data-ungroup="${esc(group.id)}">×</button>
      </div>
      <div class="window-deck-group-body">${items.map(renderRow).join("")}</div>
    </section>`;
  }

  function renderRow(w) {
    const meta = [w.remoteKind, compactUri(w.workspaceUri), w.branch, w.stale ? "历史" : ""].filter(Boolean).join(" · ");
    return `<div draggable="true" class="window-deck-row ${w.windowId === state.currentWindowId ? "current" : ""} ${w.stale ? "stale" : ""}" data-window-id="${esc(w.windowId)}" style="--wd-color:${esc(w.color)}">
      <span class="window-deck-box"></span><span class="window-deck-title" data-window-title="${esc(w.windowId)}">${esc(w.title)}<span class="window-deck-meta">${esc(meta)}</span></span>
      ${renderTerminals(w.terminals)}
      <span>${w.stale ? `<button class="window-deck-icon" data-remove="${esc(w.windowId)}">×</button>` : ""}</span>
    </div>`;
  }

  function renderTerminals(terminals) {
    const items = (terminals || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    if (!items.length) return '<span class="window-deck-terminals"></span>';
    return '<span class="window-deck-terminals">' + items.map((terminal, index) => {
      const status = terminal.state || "idle";
      return `<span class="window-deck-terminal ${esc(status)}" title="${esc(`${index + 1}. ${terminalStateLabel(status)}`)}">${terminalIcon(status)}</span>`;
    }).join("") + '</span>';
  }

  function terminalStateLabel(status) {
    if (status === "running") return "运行中";
    if (status === "waitingInput") return "等待输入";
    return "空闲";
  }
  function terminalIcon(status) {
    if (status === "running") return '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3.5v9l7-4.5-7-4.5Z"/></svg>';
    if (status === "waitingInput") return '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M3 4.5h10v7H3zM5 7h.01M8 7h.01M11 7h.01M6 9.5h4"/></svg>';
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M2.75 4.25h10.5v7.5H2.75zM5 6.5 7 8l-2 1.5M8.25 9.5h2.5"/></svg>';
  }

  function bind(scope) {
    scope.querySelectorAll(".window-deck-row").forEach(row => {
      row.addEventListener("click", event => {
        if (event.target.closest("button") || event.target.closest("input")) return;
        const item = findWindow(row.dataset.windowId);
        closeOverlay();
        action({ type: item && item.stale ? "open" : "focus", windowId: row.dataset.windowId });
      });
      row.addEventListener("dblclick", event => {
        event.preventDefault();
        beginRenameWindow(row.dataset.windowId);
      });
      row.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        showWindowMenu(row.dataset.windowId, event.clientX, event.clientY);
      }, true);
      row.addEventListener("dragstart", event => {
        dragState = { type: "window", windowId: row.dataset.windowId };
        row.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", row.dataset.windowId);
      });
      row.addEventListener("dragend", () => {
        clearDragClasses();
        dragState = null;
      });
      row.addEventListener("dragover", event => {
        if (!dragState || dragState.windowId === row.dataset.windowId) return;
        event.preventDefault();
        const merge = isMergeZone(event, row);
        clearDropClasses();
        row.classList.toggle("window-deck-drop-merge", merge);
        row.classList.toggle("window-deck-drop-before", !merge);
        if (!merge && dragState.type === "window") previewMoveBefore(dragState.windowId, row.dataset.windowId);
        if (!merge && dragState.type === "group") previewGroupBeforeWindow(dragState.groupId, row.dataset.windowId);
      });
      row.addEventListener("drop", event => {
        event.preventDefault();
        event.stopPropagation();
        const merge = isMergeZone(event, row);
        if (dragState.type === "group") moveGroupBeforeWindow(dragState.groupId, row.dataset.windowId);
        else if (merge) mergeWindows(dragState.windowId, row.dataset.windowId);
        else moveBefore(dragState.windowId, row.dataset.windowId);
        clearDragClasses();
        dragState = null;
        saveLayout();
      });
    });
    scope.querySelectorAll(".window-deck-group").forEach(group => {
      group.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        showGroupMenu(group.dataset.groupId, event.clientX, event.clientY);
      }, true);
      group.addEventListener("dragstart", event => {
        if (event.target.closest(".window-deck-row")) return;
        dragState = { type: "group", groupId: group.dataset.groupId };
        group.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", firstWindowInGroup(group.dataset.groupId));
      });
      group.addEventListener("dragend", () => {
        clearDragClasses();
        dragState = null;
      });
      group.addEventListener("dragover", event => {
        if (!dragState || dragState.groupId === group.dataset.groupId) return;
        event.preventDefault();
        clearDropClasses();
        group.classList.add("window-deck-drop-into");
        if (dragState.type === "group") previewGroupBefore(dragState.groupId, group.dataset.groupId);
      });
      group.addEventListener("drop", event => {
        if (!dragState) return;
        event.preventDefault();
        event.stopPropagation();
        if (dragState.type === "window") addWindowToGroup(dragState.windowId, group.dataset.groupId);
        else moveGroupBefore(dragState.groupId, group.dataset.groupId);
        clearDragClasses();
        dragState = null;
        saveLayout();
      });
    });
    scope.querySelectorAll("[data-collapse]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const group = state.layout.groups.find(g => g.id === btn.dataset.collapse);
      if (group) group.collapsed = !group.collapsed;
      saveLayout();
    }));
    scope.querySelectorAll("[data-ungroup]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      ungroup(btn.dataset.ungroup);
      saveLayout();
    }));
    scope.querySelectorAll("[data-remove]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      removeFromLayout(btn.dataset.remove);
      action({ type: "remove", windowId: btn.dataset.remove });
    }));
  }

  function showWindowMenu(windowId, x, y) {
    const menu = overlay.querySelector(".window-deck-menu");
    menu.innerHTML = `<button data-cmd="rename">重命名标题</button><button data-cmd="remove">删除记录</button><div class="window-deck-palette">${COLORS.map(c => `<button class="window-deck-swatch" data-color="${c}" style="--wd-color:${c}"></button>`).join("")}</div>`;
    placeMenu(menu, x, y);
    menu.querySelector('[data-cmd="rename"]').onclick = () => {
      closeMenu();
      beginRenameWindow(windowId);
    };
    menu.querySelector('[data-cmd="remove"]').onclick = () => {
      closeMenu();
      removeFromLayout(windowId);
      action({ type: "remove", windowId });
    };
    menu.querySelectorAll("[data-color]").forEach(btn => btn.onclick = () => {
      closeMenu();
      action({ type: "color", windowId, color: btn.dataset.color });
    });
  }

  function showGroupMenu(groupId, x, y) {
    const menu = overlay.querySelector(".window-deck-menu");
    const group = state.layout.groups.find(g => g.id === groupId);
    menu.innerHTML = '<button data-cmd="rename">重命名分组</button><button data-cmd="collapse">展开/合上</button><button data-cmd="ungroup">取消分组</button>';
    placeMenu(menu, x, y);
    menu.querySelector('[data-cmd="rename"]').onclick = () => {
      closeMenu();
      beginRenameGroup(groupId);
    };
    menu.querySelector('[data-cmd="collapse"]').onclick = () => {
      closeMenu();
      if (group) group.collapsed = !group.collapsed;
      saveLayout();
    };
    menu.querySelector('[data-cmd="ungroup"]').onclick = () => {
      closeMenu();
      ungroup(groupId);
      saveLayout();
    };
  }

  function beginRenameWindow(windowId) {
    const item = findWindow(windowId);
    const target = overlay.querySelector(`[data-window-title="${cssEscape(windowId)}"]`);
    if (!item || !target) return;
    beginInlineRename(target, item.title, value => action({ type: "rename", windowId, alias: value.trim() }));
  }

  function beginRenameGroup(groupId) {
    const group = state.layout.groups.find(g => g.id === groupId);
    const target = overlay.querySelector(`[data-group-title="${cssEscape(groupId)}"]`);
    if (!group || !target) return;
    beginInlineRename(target, group.title || "分组", value => {
      group.title = value.trim() || "分组";
      saveLayout();
    });
  }

  function beginInlineRename(target, value, commit) {
    const input = document.createElement("input");
    input.className = "window-deck-rename";
    input.value = value || "";
    target.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = apply => {
      if (done) return;
      done = true;
      if (apply) commit(input.value);
      else render();
    };
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  function placeMenu(menu, x, y) {
    menu.style.left = `${Math.min(x, window.innerWidth - 205)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 170)}px`;
    menu.classList.add("open");
  }
  function closeMenu() { overlay.querySelector(".window-deck-menu").classList.remove("open"); }
  function isMergeZone(event, row) { return event.offsetX > row.clientWidth * .35 && event.offsetX < row.clientWidth * .75; }
  function previewMoveBefore(sourceId, targetId) { moveDomBefore(`[data-window-id="${cssEscape(sourceId)}"]`, `[data-window-id="${cssEscape(targetId)}"]`); }
  function previewGroupBefore(sourceGroupId, targetGroupId) { moveDomBefore(`[data-group-id="${cssEscape(sourceGroupId)}"]`, `[data-group-id="${cssEscape(targetGroupId)}"]`); }
  function previewGroupBeforeWindow(sourceGroupId, targetWindowId) { moveDomBefore(`[data-group-id="${cssEscape(sourceGroupId)}"]`, `[data-window-id="${cssEscape(targetWindowId)}"]`); }
  function moveDomBefore(sourceSelector, targetSelector) {
    const popup = overlay.querySelector(".window-deck-popup");
    const source = popup.querySelector(sourceSelector);
    const target = popup.querySelector(targetSelector);
    if (!source || !target || source === target) return;
    const sourceBlock = source.classList.contains("window-deck-group") ? source : source.closest(".window-deck-group") || source;
    const targetBlock = target.classList.contains("window-deck-group") ? target : target.closest(".window-deck-group") || target;
    if (sourceBlock === targetBlock) return;
    targetBlock.parentElement.insertBefore(sourceBlock, targetBlock);
  }
  function clearDropClasses() {
    overlay.querySelectorAll(".window-deck-drop-before,.window-deck-drop-merge,.window-deck-drop-into").forEach(el => {
      el.classList.remove("window-deck-drop-before", "window-deck-drop-merge", "window-deck-drop-into");
    });
  }
  function clearDragClasses() {
    clearDropClasses();
    overlay.querySelectorAll(".dragging").forEach(el => el.classList.remove("dragging"));
  }
  function moveBefore(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    removeFromGroups(sourceId);
    state.layout.order = (state.layout.order || []).filter(id => id !== sourceId);
    const index = Math.max(0, state.layout.order.indexOf(targetId));
    state.layout.order.splice(index, 0, sourceId);
  }
  function mergeWindows(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const existing = (state.layout.groups || []).find(g => g.windowIds.includes(targetId));
    removeFromGroups(sourceId);
    if (existing) existing.windowIds = dedupe([...existing.windowIds, sourceId]);
    else {
      const s = findWindow(sourceId), t = findWindow(targetId);
      state.layout.groups.push({ id: "group-" + Date.now().toString(36), title: [t && t.title, s && s.title].filter(Boolean).join(" / ") || "分组", color: t && t.color, collapsed: false, windowIds: [targetId, sourceId] });
    }
    state.layout.order = state.layout.order.filter(id => id !== sourceId);
    if (!state.layout.order.includes(targetId)) state.layout.order.push(targetId);
  }
  function addWindowToGroup(windowId, groupId) {
    const group = state.layout.groups.find(g => g.id === groupId);
    if (!windowId || !group || group.windowIds.includes(windowId)) return;
    removeFromGroups(windowId);
    group.windowIds.push(windowId);
    group.collapsed = false;
    state.layout.order = state.layout.order.filter(id => id !== windowId);
  }
  function moveGroupBefore(sourceGroupId, targetGroupId) {
    if (!sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId) return;
    const sourceFirst = firstWindowInGroup(sourceGroupId);
    const targetFirst = firstWindowInGroup(targetGroupId);
    if (!sourceFirst || !targetFirst) return;
    state.layout.order = state.layout.order.filter(id => id !== sourceFirst);
    const index = Math.max(0, state.layout.order.indexOf(targetFirst));
    state.layout.order.splice(index, 0, sourceFirst);
  }
  function moveGroupBeforeWindow(sourceGroupId, targetWindowId) {
    if (!sourceGroupId || !targetWindowId) return;
    const sourceFirst = firstWindowInGroup(sourceGroupId);
    if (!sourceFirst || sourceFirst === targetWindowId) return;
    state.layout.order = state.layout.order.filter(id => id !== sourceFirst);
    const index = Math.max(0, state.layout.order.indexOf(targetWindowId));
    state.layout.order.splice(index, 0, sourceFirst);
  }
  function removeFromGroups(windowId) {
    state.layout.groups = (state.layout.groups || []).map(g => ({ ...g, windowIds: g.windowIds.filter(id => id !== windowId) })).filter(g => g.windowIds.length);
  }
  function removeFromLayout(windowId) {
    state.layout.order = (state.layout.order || []).filter(id => id !== windowId);
    removeFromGroups(windowId);
  }
  function ungroup(groupId) {
    const group = state.layout.groups.find(g => g.id === groupId);
    state.layout.groups = state.layout.groups.filter(g => g.id !== groupId);
    if (!group) return;
    const at = Math.max(0, state.layout.order.indexOf(group.windowIds[0]));
    state.layout.order = state.layout.order.filter(id => !group.windowIds.includes(id));
    state.layout.order.splice(at, 0, ...group.windowIds);
  }
  function normalizeLayout(next) {
    const ids = (state.windows || []).map(w => w.windowId);
    const known = new Set(ids);
    const seen = new Set();
    const order = (next.order || []).filter(id => known.has(id) && !seen.has(id) && seen.add(id));
    ids.forEach(id => { if (!seen.has(id)) order.push(id); });
    const groups = (next.groups || []).map(g => ({ id: g.id, title: g.title || "分组", color: g.color, collapsed: Boolean(g.collapsed), windowIds: dedupe(g.windowIds || []).filter(id => known.has(id)) })).filter(g => g.windowIds.length);
    return { order, groups };
  }
  function firstWindowInGroup(groupId) {
    const group = state.layout.groups.find(g => g.id === groupId);
    return group && group.windowIds[0] || "";
  }
  function saveLayout() {
    state.layout = normalizeLayout(state.layout);
    action({ type: "layout", layout: state.layout });
  }
  function findWindow(id) { return (state.windows || []).find(w => w.windowId === id); }
  function compactUri(uri) {
    if (!uri) return "";
    try {
      const parsed = new URL(uri);
      return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.pathname || uri);
    } catch {
      return uri;
    }
  }
  function dedupe(values) {
    const seen = new Set();
    return values.filter(value => !seen.has(value) && seen.add(value));
  }
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value || "").replace(/["\\]/g, "\\$&");
  }
  function esc(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  setInterval(() => { if (open) refresh().then(render); }, 2000);
  setInterval(pollCommand, 350);
})();
