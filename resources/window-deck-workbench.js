(function () {
  const BRIDGE = "http://127.0.0.1:39417";
  const COLORS = ["#4f8cff", "#2fb344", "#f59f00", "#e03131", "#9c36b5", "#0ca678", "#f76707", "#495057"];
  let state = { windows: [], layout: { order: [], groups: [] }, currentWindowId: "" };
  let open = false;
  let dragState = null;

  const style = document.createElement("style");
  style.textContent = `
    .window-deck-root { position: relative; display: flex; align-items: center; height: 100%; margin-left: 6px; z-index: 1000; }
    .window-deck-button { height: 24px; padding: 0 8px; border: 1px solid var(--vscode-commandCenter-inactiveBorder, transparent); border-radius: 4px; color: var(--vscode-titleBar-activeForeground); background: transparent; cursor: pointer; font: 12px var(--monaco-monospace-font, sans-serif); }
    .window-deck-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .window-deck-popup { position: fixed; top: 34px; right: 10px; min-width: 360px; max-width: min(760px, calc(100vw - 20px)); max-height: min(520px, calc(100vh - 60px)); overflow: auto; padding: 8px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); box-shadow: 0 8px 28px rgba(0,0,0,.35); z-index: 999999; display: none; }
    .window-deck-popup.open { display: block; }
    .window-deck-row { display: grid; grid-template-columns: 10px minmax(120px, 1fr) auto; gap: 8px; align-items: center; min-height: 30px; padding: 5px 7px; margin: 3px 0; border: 1px solid var(--wd-color); border-left-width: 4px; border-radius: 5px; background: var(--vscode-list-inactiveSelectionBackground); cursor: pointer; user-select: none; }
    .window-deck-row.current { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .window-deck-row.stale { opacity: .62; border-style: dashed; }
    .window-deck-dot { width: 10px; height: 10px; border-radius: 999px; background: var(--wd-color); }
    .window-deck-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
    .window-deck-actions { display: flex; gap: 4px; }
    .window-deck-x { width: 18px; height: 18px; border: 0; border-radius: 4px; color: inherit; background: transparent; cursor: pointer; }
    .window-deck-x:hover { background: var(--vscode-toolbar-hoverBackground); }
    .window-deck-menu { position: fixed; min-width: 170px; padding: 5px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; background: var(--vscode-dropdown-background); box-shadow: 0 6px 20px rgba(0,0,0,.35); z-index: 1000000; display: none; }
    .window-deck-menu.open { display: block; }
    .window-deck-menu button { display: block; width: 100%; min-height: 26px; padding: 4px 8px; border: 0; border-radius: 4px; color: var(--vscode-dropdown-foreground); background: transparent; text-align: left; cursor: pointer; }
    .window-deck-menu button:hover { background: var(--vscode-list-hoverBackground); }
    .window-deck-palette { display: grid; grid-template-columns: repeat(8, 18px); gap: 5px; padding: 6px 4px 3px; }
    .window-deck-swatch { width: 18px !important; min-height: 18px !important; padding: 0 !important; background: var(--wd-color) !important; border: 1px solid var(--vscode-contrastBorder) !important; }
    .window-deck-group { margin: 5px 0; border: 1px solid var(--vscode-widget-border); border-radius: 6px; overflow: hidden; }
    .window-deck-group.window-deck-drop-into { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .window-deck-group-head { display: flex; gap: 6px; align-items: center; min-height: 28px; padding: 4px 7px; cursor: pointer; background: var(--vscode-sideBar-background); }
    .window-deck-group-title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .window-deck-group.collapsed .window-deck-group-body { display: none; }
    .window-deck-drop-before { box-shadow: -3px 0 0 var(--vscode-focusBorder); }
    .window-deck-drop-merge { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.className = "window-deck-root";
  root.innerHTML = `<button class="window-deck-button" title="Window Deck">Window Deck ▾</button><div class="window-deck-popup"></div><div class="window-deck-menu"></div>`;

  function mount() {
    if (document.querySelector(".window-deck-root")) return true;
    const target = document.querySelector(".part.titlebar .titlebar-right") ||
      document.querySelector(".part.titlebar .window-controls-container") ||
      document.querySelector(".part.titlebar") ||
      document.querySelector(".tabs-and-actions-container .editor-actions") ||
      document.querySelector(".tabs-and-actions-container");
    if (!target) return false;
    target.prepend(root);
    root.querySelector(".window-deck-button").addEventListener("click", async (event) => {
      event.stopPropagation();
      open = !open;
      await refresh();
      render();
    });
    document.addEventListener("click", (event) => {
      if (!root.contains(event.target)) {
        open = false;
        render();
      }
    }, true);
    return true;
  }

  const mountTimer = setInterval(() => {
    if (mount()) clearInterval(mountTimer);
  }, 500);

  async function refresh() {
    try {
      const res = await fetch(`${BRIDGE}/state`);
      if (!res.ok) return;
      state = await res.json();
    } catch {}
  }

  async function action(payload) {
    await fetch(`${BRIDGE}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
    await refresh();
    render();
  }

  function render() {
    const popup = root.querySelector(".window-deck-popup");
    popup.classList.toggle("open", open);
    if (!open) return;
    const grouped = new Set((state.layout.groups || []).flatMap(g => g.windowIds));
    const byId = new Map((state.windows || []).map(w => [w.windowId, w]));
    const rows = [];
    for (const id of state.layout.order || []) {
      const group = (state.layout.groups || []).find(g => g.windowIds[0] === id);
      if (group) rows.push(renderGroup(group, byId));
      else if (!grouped.has(id) && byId.has(id)) rows.push(renderRow(byId.get(id)));
    }
    for (const w of state.windows || []) {
      if (!(state.layout.order || []).includes(w.windowId) && !grouped.has(w.windowId)) rows.push(renderRow(w));
    }
    popup.innerHTML = rows.join("") || `<div style="padding:8px; opacity:.7">没有已注册窗口</div>`;
    bind(popup);
  }

  function renderGroup(group, byId) {
    const items = group.windowIds.map(id => byId.get(id)).filter(Boolean);
    const title = group.title || items.map(w => w.title).join(" / ") || "分组";
    return `<section class="window-deck-group ${group.collapsed ? "collapsed" : ""}" data-group-id="${esc(group.id)}">
      <div class="window-deck-group-head" draggable="true" data-group-id="${esc(group.id)}"><span>${group.collapsed ? "›" : "⌄"}</span><span class="window-deck-group-title">${esc(title)}</span><button class="window-deck-x" data-ungroup="${esc(group.id)}">×</button></div>
      <div class="window-deck-group-body">${items.map(renderRow).join("")}</div>
    </section>`;
  }

  function renderRow(w) {
    return `<div draggable="true" class="window-deck-row ${w.windowId === state.currentWindowId ? "current" : ""} ${w.stale ? "stale" : ""}" data-window-id="${esc(w.windowId)}" style="--wd-color:${esc(w.color)}">
      <span class="window-deck-dot"></span><span class="window-deck-title">#${esc(w.title)}</span>
      <span class="window-deck-actions">${w.stale ? `<button class="window-deck-x" data-remove="${esc(w.windowId)}">×</button>` : ""}</span>
    </div>`;
  }

  function bind(scope) {
    scope.querySelectorAll(".window-deck-row").forEach(row => {
      row.addEventListener("click", event => {
        if (event.target.closest("button")) return;
        const w = findWindow(row.dataset.windowId);
        action({ type: w && w.stale ? "open" : "focus", windowId: row.dataset.windowId });
      });
      row.addEventListener("pointerdown", event => {
        if (event.button !== 2) return;
        event.preventDefault();
        event.stopPropagation();
        showMenu(row.dataset.windowId, event.clientX, event.clientY);
      }, true);
      row.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        showMenu(row.dataset.windowId, event.clientX, event.clientY);
      }, true);
      row.addEventListener("dragstart", event => {
        dragState = { type: "window", windowId: row.dataset.windowId };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", row.dataset.windowId);
      });
      row.addEventListener("dragend", () => {
        dragState = null;
        clearDropClasses(scope);
      });
      row.addEventListener("dragover", event => {
        if (!dragState || dragState.windowId === row.dataset.windowId) return;
        event.preventDefault();
        row.classList.toggle("window-deck-drop-merge", event.offsetX > row.clientWidth * .35 && event.offsetX < row.clientWidth * .75);
        row.classList.toggle("window-deck-drop-before", event.offsetX <= row.clientWidth * .35);
      });
      row.addEventListener("dragleave", () => row.classList.remove("window-deck-drop-merge", "window-deck-drop-before"));
      row.addEventListener("drop", event => {
        event.preventDefault();
        const merge = event.offsetX > row.clientWidth * .35 && event.offsetX < row.clientWidth * .75;
        if (merge) mergeWindows(dragState.windowId, row.dataset.windowId);
        else moveBefore(dragState.windowId, row.dataset.windowId);
        dragState = null;
        saveLayout();
      });
    });
    scope.querySelectorAll(".window-deck-group").forEach(group => {
      group.addEventListener("dragover", event => {
        if (!dragState) return;
        event.preventDefault();
        group.classList.add("window-deck-drop-into");
      });
      group.addEventListener("dragleave", () => group.classList.remove("window-deck-drop-into"));
      group.addEventListener("drop", event => {
        if (!dragState) return;
        event.preventDefault();
        group.classList.remove("window-deck-drop-into");
        addWindowToGroup(dragState.windowId, group.dataset.groupId);
        dragState = null;
        saveLayout();
      });
    });
    scope.querySelectorAll(".window-deck-group-head").forEach(head => {
      head.addEventListener("dragstart", event => {
        dragState = { type: "group", groupId: head.dataset.groupId, windowId: firstWindowInGroup(head.dataset.groupId) };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", dragState.windowId || "");
      });
      head.addEventListener("dragover", event => {
        if (!dragState) return;
        event.preventDefault();
        head.parentElement.classList.add("window-deck-drop-before");
      });
      head.addEventListener("dragleave", () => head.parentElement.classList.remove("window-deck-drop-before"));
      head.addEventListener("drop", event => {
        if (!dragState) return;
        event.preventDefault();
        head.parentElement.classList.remove("window-deck-drop-before");
        if (dragState.type === "window") addWindowToGroup(dragState.windowId, head.dataset.groupId);
        else moveGroupBefore(dragState.groupId, head.dataset.groupId);
        dragState = null;
        saveLayout();
      });
    });
    scope.querySelectorAll("[data-remove]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      removeFromLayout(btn.dataset.remove);
      action({ type: "remove", windowId: btn.dataset.remove });
    }));
    scope.querySelectorAll(".window-deck-group-head").forEach(head => head.addEventListener("click", event => {
      if (event.target.closest("button")) return;
      const group = state.layout.groups.find(g => g.id === head.parentElement.dataset.groupId);
      if (group) group.collapsed = !group.collapsed;
      saveLayout();
    }));
    scope.querySelectorAll("[data-ungroup]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      ungroup(btn.dataset.ungroup);
      saveLayout();
    }));
  }

  function showMenu(windowId, x, y) {
    const menu = root.querySelector(".window-deck-menu");
    const w = findWindow(windowId);
    menu.innerHTML = `<button data-cmd="rename">重命名</button><button data-cmd="remove">删除记录</button><div class="window-deck-palette">${COLORS.map(c => `<button class="window-deck-swatch" data-color="${c}" style="--wd-color:${c}"></button>`).join("")}</div>`;
    menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 160)}px`;
    menu.classList.add("open");
    menu.querySelector('[data-cmd="rename"]').onclick = () => {
      menu.classList.remove("open");
      const alias = prompt("窗口名称", w ? w.title : "");
      if (alias !== null) action({ type: "rename", windowId, alias: alias.trim() });
    };
    menu.querySelector('[data-cmd="remove"]').onclick = () => {
      menu.classList.remove("open");
      removeFromLayout(windowId);
      action({ type: "remove", windowId });
    };
    menu.querySelectorAll("[data-color]").forEach(btn => btn.onclick = () => {
      menu.classList.remove("open");
      action({ type: "color", windowId, color: btn.dataset.color });
    });
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
      if (existing) existing.windowIds = [...new Set([...existing.windowIds, sourceId])];
    else {
      const s = findWindow(sourceId), t = findWindow(targetId);
      state.layout.groups.push({ id: "group-" + Date.now().toString(36), title: [t && t.title, s && s.title].filter(Boolean).join(" / "), color: t && t.color, collapsed: false, windowIds: [targetId, sourceId] });
    }
    state.layout.order = state.layout.order.filter(id => id !== sourceId);
    if (!state.layout.order.includes(targetId)) state.layout.order.push(targetId);
  }
  function addWindowToGroup(windowId, groupId) {
    if (!windowId || !groupId) return;
    const group = state.layout.groups.find(g => g.id === groupId);
    if (!group || group.windowIds.includes(windowId)) return;
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
    if (group) {
      const at = Math.max(0, state.layout.order.indexOf(group.windowIds[0]));
      state.layout.order = state.layout.order.filter(id => !group.windowIds.includes(id));
      state.layout.order.splice(at, 0, ...group.windowIds);
    }
  }
  function firstWindowInGroup(groupId) {
    const group = state.layout.groups.find(g => g.id === groupId);
    return group && group.windowIds[0] || "";
  }
  function clearDropClasses(scope) {
    scope.querySelectorAll(".window-deck-drop-before,.window-deck-drop-merge,.window-deck-drop-into").forEach(el => {
      el.classList.remove("window-deck-drop-before", "window-deck-drop-merge", "window-deck-drop-into");
    });
  }
  function saveLayout() {
    action({ type: "layout", layout: state.layout });
  }
  function findWindow(id) { return (state.windows || []).find(w => w.windowId === id); }
  function esc(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  setInterval(() => { if (open) refresh().then(render); }, 2000);
})();
