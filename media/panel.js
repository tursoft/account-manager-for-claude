(function () {
  const vscode = acquireVsCodeApi();
  let state = { accounts: [], warnThreshold: 80 };

  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");
  const menuEl = document.getElementById("menu");
  let menuAnchor = null;

  const ICONS = {
    more: '<circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/>',
    swap: '<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/>',
    window: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/>',
    hi: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
    key: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.3 8.7 13 3M11 5l1.5 1.5"/>',
    edit: '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3z"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    personAdd: '<circle cx="6.5" cy="5.5" r="2.5"/><path d="M2 13.5c.5-2.5 2.3-3.5 4.5-3.5s4 1 4.5 3.5M12.5 5v4M10.5 7h4"/>',
  };

  function icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "ico");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = ICONS[name];
    return svg;
  }

  function post(type, id) {
    vscode.postMessage(id ? { type, id } : { type });
  }

  function bindToolbar(id, type, iconName) {
    const b = document.getElementById(id);
    if (iconName) b.prepend(icon(iconName));
    b.addEventListener("click", () => post(type));
  }
  bindToolbar("addBtn", "add", "plus");
  bindToolbar("loginBtn", "login", "personAdd");
  bindToolbar("sayHiBtn", "sayHiAll", "hi");
  bindToolbar("refreshBtn", "refreshAll", "refresh");
  bindToolbar("emptyAddBtn", "add");
  bindToolbar("emptyLoginBtn", "login");

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "state") {
      state = msg;
      closeMenu();
      render();
    }
  });

  // ---- formatting -------------------------------------------------------

  function fmtDuration(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${mins % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  function fmtReset(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    const diff = t - Date.now();
    const short = diff <= 0 ? "soon" : fmtDuration(diff);
    return { short, title: `Resets ${diff <= 0 ? "soon" : "in " + short} · ${new Date(t).toLocaleString()}` };
  }

  function fmtAgo(ts) {
    if (!ts) return null;
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.round(m / 60)}h`;
  }

  function shortLabel(label) {
    if (/^session/i.test(label)) return "5h";
    const weekly = /^weekly\s*(?:\((.*)\))?\s*(.*)$/i.exec(label);
    if (weekly) {
      const scope = (weekly[1] || weekly[2] || "").trim();
      return !scope || /^all$/i.test(scope) ? "7d" : scope;
    }
    return label;
  }

  // ---- building blocks --------------------------------------------------

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function iconButton(iconName, title, onClick, extraClass) {
    const b = el("button", "icon-btn" + (extraClass ? " " + extraClass : ""));
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(icon(iconName));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(b);
    });
    return b;
  }

  function meter(w, warn) {
    const level = w.percent >= warn ? "danger" : w.percent >= warn * 0.75 ? "warn" : "ok";
    const row = el("div", "meter " + level);
    row.title = `${w.label}: ${w.percent}%`;

    const bar = el("div", "bar");
    const fill = el("div", "fill");
    fill.style.width = Math.min(100, Math.max(0, w.percent)) + "%";
    bar.appendChild(fill);

    const reset = fmtReset(w.resetsAt);
    const resetEl = el("span", "reset", reset ? reset.short : "");
    if (reset) {
      resetEl.title = reset.title;
      row.title += ` · ${reset.title}`;
    }

    row.append(el("span", "m-label", shortLabel(w.label)), bar, el("span", "pct", w.percent + "%"), resetEl);
    return row;
  }

  function card(acc, warn) {
    const root = el("div", "card" + (acc.isActive ? " active" : "") + (acc.error ? " has-error" : ""));

    const head = el("div", "card-head");
    const dot = el("span", "dot");
    dot.title = acc.isActive ? "Active in Claude Code" : "Inactive";
    const name = el("span", "name", acc.label);
    name.title = acc.label;
    head.append(dot, name);

    if (acc.subscriptionType) head.appendChild(el("span", "badge", acc.subscriptionType));
    head.appendChild(el("span", "spacer"));

    const ago = fmtAgo(acc.fetchedAt);
    if (ago) {
      const agoEl = el("span", "ago", ago);
      agoEl.title = `Usage updated ${ago} ago`;
      head.appendChild(agoEl);
    }

    if (!acc.isActive) {
      head.appendChild(iconButton("swap", "Switch to this account", () => post("switch", acc.id), "quick"));
    }
    head.appendChild(
      iconButton("more", "More actions", (btn) => toggleMenu(btn, acc), "menu-btn")
    );
    root.appendChild(head);

    if (acc.windows && acc.windows.length) {
      const meters = el("div", "meters");
      for (const w of acc.windows) meters.appendChild(meter(w, warn));
      root.appendChild(meters);
    } else if (!acc.error) {
      root.appendChild(el("div", "muted-line", "No usage data yet"));
    }

    if (acc.error) {
      const err = el("div", "error");
      const text = el("span", "error-text", acc.error);
      err.title = acc.error;
      err.appendChild(text);
      if (acc.needsReauthorization) {
        const fix = el("button", "link-btn", "Reauthorize");
        fix.addEventListener("click", () => post("reauthorize", acc.id));
        err.appendChild(fix);
      }
      root.appendChild(err);
    }

    return root;
  }

  // ---- dropdown menu ----------------------------------------------------

  function menuItems(acc) {
    const items = [];
    if (!acc.isActive) items.push({ icon: "swap", label: "Switch to this account", type: "switch" });
    items.push({ icon: "window", label: "Open in independent window", type: "openWindow" });
    if (!acc.isActive) items.push({ icon: "hi", label: "Say Hi (warmup)", type: "sayHi" });
    items.push({ icon: "refresh", label: "Refresh usage", type: "refresh" });
    items.push(null);
    items.push({
      icon: "key",
      label: "Reauthorize…",
      type: "reauthorize",
      accent: acc.needsReauthorization,
    });
    items.push({ icon: "edit", label: "Rename…", type: "rename" });
    items.push({ icon: "trash", label: "Remove profile…", type: "remove", danger: true });
    return items;
  }

  function toggleMenu(anchor, acc) {
    if (menuAnchor === anchor) {
      closeMenu();
      return;
    }
    closeMenu();
    menuEl.innerHTML = "";
    menuEl.appendChild(el("div", "menu-title", acc.label));

    for (const item of menuItems(acc)) {
      if (!item) {
        menuEl.appendChild(el("div", "menu-sep"));
        continue;
      }
      const b = el(
        "button",
        "menu-item" + (item.danger ? " danger" : "") + (item.accent ? " accent" : "")
      );
      b.setAttribute("role", "menuitem");
      b.append(icon(item.icon), el("span", "", item.label));
      b.addEventListener("click", () => {
        closeMenu();
        post(item.type, acc.id);
      });
      menuEl.appendChild(b);
    }

    menuEl.classList.remove("hidden");
    menuAnchor = anchor;
    anchor.classList.add("open");
    anchor.setAttribute("aria-expanded", "true");
    positionMenu(anchor);
    const first = menuEl.querySelector(".menu-item");
    if (first) first.focus();
  }

  function positionMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const m = menuEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let top = r.bottom + 4;
    if (top + m.height > vh - 4 && r.top - m.height - 4 > 4) top = r.top - m.height - 4;
    const left = Math.max(4, Math.min(r.right - m.width, vw - m.width - 4));
    menuEl.style.top = top + "px";
    menuEl.style.left = left + "px";
  }

  function closeMenu() {
    if (!menuAnchor) return;
    menuEl.classList.add("hidden");
    menuAnchor.classList.remove("open");
    menuAnchor.setAttribute("aria-expanded", "false");
    menuAnchor = null;
  }

  document.addEventListener("click", (e) => {
    if (menuAnchor && !menuEl.contains(e.target)) closeMenu();
  });
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("scroll", closeMenu, true);
  document.addEventListener("keydown", (e) => {
    if (!menuAnchor) return;
    if (e.key === "Escape") {
      const anchor = menuAnchor;
      closeMenu();
      anchor.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(menuEl.querySelectorAll(".menu-item"));
      const i = items.indexOf(document.activeElement);
      const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    }
  });

  // ---- render -----------------------------------------------------------

  function render() {
    listEl.innerHTML = "";
    const accounts = state.accounts || [];
    if (accounts.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    for (const acc of accounts) {
      listEl.appendChild(card(acc, state.warnThreshold || 80));
    }
  }

  // Refresh countdowns every minute (but don't yank an open menu away).
  setInterval(() => {
    if (!menuAnchor) render();
  }, 60000);

  vscode.postMessage({ type: "ready" });
})();
