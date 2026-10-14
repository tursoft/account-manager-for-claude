import { AVATAR_COLORS, avatarDescription, avatarState, starburstGlyph } from "../src/avatar";
import { limitName, noProposalReason, propose, rankAccounts } from "../src/propose";
import { nameTone, nameToneDescription, resetTone, toneOfPercent } from "../src/tone";
import {
  extraFilterLabels,
  filtersActive,
  limitState,
  matchesListing,
  normalizeListing,
  planName,
  planOf,
  scopesOf,
  SORTS,
  sortAccounts,
} from "../src/listing";

(function () {
  const vscode = acquireVsCodeApi();
  let state = { accounts: [], warnThreshold: 80 };

  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");
  const menuEl = document.getElementById("menu");
  let menuAnchor = null;
  let dragId = null;
  let pendingRender = false;
  let lastActiveId;
  let busy = { ids: [], all: false, session: false };
  const progressEl = document.getElementById("progress");

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
    up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
    down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    search: '<circle cx="7" cy="7" r="4.25"/><path d="m10.2 10.2 3.3 3.3"/>',
    save: '<path d="M3 2.5h8l2 2v9H3z"/><path d="M5.5 2.5v3h4v-3M5.5 13.5v-4h5v4"/>',
    sort: '<path d="M3 4.5h10M3 8h7M3 11.5h4"/>',
    funnel: '<path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5z"/>',
    check: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
    blank: '',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.3V11M8 4.9v.2"/>',
    warning: '<path d="M8 2.3 14.2 13H1.8z"/><path d="M8 6.4v3.2M8 11.2v.2"/>',
    signIn: '<path d="M9.5 2.5h3v11h-3M2.5 8h7M7 5.5 9.5 8 7 10.5"/>',
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

  // The sidebar banner opens its site in the browser through the extension (an allowlisted link).
  const bjfBanner = document.getElementById("bjfBanner");
  if (bjfBanner) {
    bjfBanner.addEventListener("click", (e) => {
      e.preventDefault();
      vscode.postMessage({ type: "openLink", url: bjfBanner.dataset.link });
    });
    // A logo file that is missing should not show as a broken image.
    for (const img of bjfBanner.querySelectorAll("img")) {
      img.addEventListener("error", () => img.remove());
    }
  }

  /** Double-clicking a name copies it; the extension writes the clipboard and answers "copied". */
  function copyOnDoubleClick(node, id) {
    node.addEventListener("mousedown", (e) => {
      if (e.detail > 1) e.preventDefault(); // no word selection on the second click
    });
    node.addEventListener("dblclick", () => post("copyName", id));
  }

  const toastEl = document.getElementById("toast");
  let toastTimer;

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  function bindToolbar(id, type, iconName) {
    const b = document.getElementById(id);
    if (iconName) b.prepend(icon(iconName));
    b.addEventListener("click", () => post(type));
  }
  bindToolbar("loginBtn", "login", "personAdd");
  // Info and warning boxes declare their icon in markup.
  for (const n of document.querySelectorAll(".notice[data-icon]")) n.prepend(icon(n.dataset.icon));

  document.getElementById("enableTrackingBtn").addEventListener("click", () => post("enableTracking"));

  bindToolbar("emptyLoginBtn", "login");
  bindToolbar("emptyRestoreBtn", "restore");

  // ---- about sheet ------------------------------------------------------

  const aboutEl = document.getElementById("about");
  const aboutClose = document.getElementById("aboutClose");
  let focusBeforeAbout = null;
  aboutClose.appendChild(icon("close"));

  function showAbout() {
    closeMenu();
    focusBeforeAbout = document.activeElement;
    document.getElementById("aboutVersion").textContent = state.version || "";
    aboutEl.classList.remove("hidden");
    aboutClose.focus();
  }

  function hideAbout() {
    if (aboutEl.classList.contains("hidden")) return;
    aboutEl.classList.add("hidden");
    if (focusBeforeAbout && focusBeforeAbout.focus) focusBeforeAbout.focus();
  }

  aboutClose.addEventListener("click", hideAbout);
  aboutEl.addEventListener("click", (e) => {
    if (e.target === aboutEl) hideAbout();
  });
  for (const a of aboutEl.querySelectorAll("a[data-link]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      vscode.postMessage({ type: "openLink", url: a.dataset.link });
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideAbout();
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "showAbout") {
      showAbout();
    } else if (msg.type === "propose") {
      showProposal(msg.kind, Boolean(msg.automatic));
    } else if (msg.type === "copied") {
      showToast(msg.ok ? `Copied “${msg.name}”` : "Could not copy to the clipboard");
    } else if (msg.type === "busy") {
      busy = msg;
      applyBusy();
    } else if (msg.type === "state") {
      state = msg;
      if (msg.busy) busy = msg.busy;
      syncViewSettings(msg);
      closeMenu();
      // Re-rendering mid-drag would destroy the dragged card; catch up on dragend.
      if (dragId) pendingRender = true;
      else render();
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
    return { short, ms: diff, title: `Resets ${diff <= 0 ? "soon" : "in " + short} · ${new Date(t).toLocaleString()}` };
  }

  /**
   * Writes a reset time into `node`. The time of a limit that is used up is colored (under 10
   * min yellow, under 1 h orange, over 1 day red); while some limit is left it stays gray.
   */
  function paintReset(node, iso, percent) {
    const reset = fmtReset(iso);
    node.textContent = reset ? reset.short : "";
    node.classList.remove("reset-imminent", "reset-soon", "reset-far");
    const tone = reset ? resetTone(percent, reset.ms) : undefined;
    if (tone) node.classList.add("reset-" + tone);
    return reset;
  }

  function fmtAgo(ts) {
    if (!ts) return null;
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.round(m / 60)}h`;
  }

  /** Keeps the relative times ("3h 38m", "20s") and the reset colors current between state updates. */
  function refreshTimes() {
    for (const n of document.querySelectorAll("[data-reset]")) {
      const reset = paintReset(n, n.dataset.reset, Number(n.dataset.percent));
      if (reset) n.title = reset.title;
    }
    for (const n of document.querySelectorAll("[data-ago]")) {
      const ago = fmtAgo(Number(n.dataset.ago));
      if (ago) {
        n.textContent = ago;
        n.title = `Usage last updated ${ago} ago (${new Date(Number(n.dataset.ago)).toLocaleTimeString()})\nRefreshed on the polling interval, after a switch, and with the Refresh button.`;
      }
    }
  }
  setInterval(refreshTimes, 30_000);

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
    const level = toneOfPercent(w.percent, warn);
    const row = el("div", "meter " + level);
    const left = 100 - w.percent;
    const state = w.percent >= 100 ? "used up" : `${left}% left`;
    row.title = `${w.label}: ${w.percent}% used, ${state}`;

    const label = el("span", "m-label", shortLabel(w.label));
    label.title = w.kind === "session" ? "5-hour session limit" : w.label + (w.kind === "weekly_all" ? " (7-day limit)" : " (7-day limit for this model)");

    const bar = el("div", "bar");
    const fill = el("div", "fill");
    fill.style.width = Math.min(100, Math.max(0, w.percent)) + "%";
    bar.appendChild(fill);
    bar.title = `${w.percent}% of the ${shortLabel(w.label)} limit used, ${state}`;

    const pct = el("span", "pct", w.percent + "%");
    pct.title = `${w.percent}% used · ${state}`;

    const resetEl = el("span", "reset");
    const reset = paintReset(resetEl, w.resetsAt, w.percent);
    if (reset) {
      resetEl.dataset.reset = w.resetsAt;
      resetEl.dataset.percent = String(w.percent);
      // "Resets in 1h 21m · Tue 20:11" plus, when used up, why the time is colored.
      resetEl.title = reset.title + (w.percent >= 100 ? "\nThis limit is used up: the time until it is usable again." : "\nTime until this limit's usage resets to 0%.");
      row.title += ` · ${reset.title}`;
    } else {
      resetEl.title = "Reset time not known";
    }

    row.append(label, bar, pct, resetEl);
    return row;
  }

  function card(acc, warn) {
    const root = el(
      "div",
      "card" +
        (acc.isActive ? " active" : "") +
        (acc.error ? " has-error" : "") +
        (acc.needsReauthorization ? " expired" : "")
    );
    root.dataset.id = acc.id;
    // Dragging only makes sense in the user's own order.
    root.draggable = filter.sort === "custom";
    if (root.draggable) {
      const grip = el("span", "grip");
      grip.title = "Drag to reorder";
      root.appendChild(grip);
    }

    // Avatar on the left inside the card; everything else stacks in the body.
    const body = el("div", "card-body");
    const head = el("div", "card-head");
    // Green while the account can start sessions (a used-up model limit such as Fable blocks
    // only that model); red once the 5h or the general weekly limit is used up.
    const tone = nameTone(acc);
    const name = el("span", "name" + (tone ? ` tone-${tone}` : ""), acc.label);
    name.title = [acc.label, nameToneDescription(acc), acc.isActive ? "Active in Claude Code" : "", "Double-click to copy"]
      .filter(Boolean)
      .join("\n");
    copyOnDoubleClick(name, acc.id);
    head.append(name);

    if (acc.subscriptionType) {
      const plan = el("span", "badge", acc.subscriptionType);
      plan.title = `Plan: ${acc.subscriptionType}`;
      head.appendChild(plan);
    }
    if (acc.needsReauthorization) {
      const expired = el("span", "badge expired-badge");
      expired.append(icon("key"), el("span", "", "Login expired"));
      expired.title = "The saved login (refresh token) expired or was revoked. Reauthorize to use this account again.";
      head.appendChild(expired);
    }
    head.appendChild(el("span", "spacer"));

    const actions = el("span", "head-actions");
    actions.append(
      ...quickButtons(acc),
      iconButton("more", "More actions", (btn) => toggleMenu(btn, acc.label, accountMenuItems(acc)), "menu-btn")
    );
    head.appendChild(actions);
    body.appendChild(head);

    if (acc.windows && acc.windows.length) {
      const meters = el("div", "meters");
      for (const w of acc.windows) meters.appendChild(meter(w, warn));
      body.appendChild(meters);
    } else if (!acc.error) {
      body.appendChild(el("div", "muted-line", "No usage data yet"));
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
      body.appendChild(err);
    }

    // Left column: the avatar with the time of the last usage update below it.
    const lead = el("div", "card-lead");
    lead.appendChild(avatar(acc));
    const ago = fmtAgo(acc.fetchedAt);
    if (ago) {
      const agoEl = el("span", "ago", ago);
      agoEl.dataset.ago = String(acc.fetchedAt);
      agoEl.title = `Usage last updated ${ago} ago (${new Date(acc.fetchedAt).toLocaleTimeString()})\nRefreshed on the polling interval, after a switch, and with the Refresh button.`;
      lead.appendChild(agoEl);
    }
    root.append(lead, body);
    return root;
  }

  /** Account providers; each account shows its provider's mark. More can be added here. */
  const PROVIDERS = {
    claude: { name: "Claude", glyph: starburstGlyph(12) },
  };

  function providerOf(acc) {
    return PROVIDERS[acc.provider] || PROVIDERS.claude;
  }

  /** Round avatar inside a card: the provider's mark; green while the account has limit left, orange once a limit is used up. */
  function avatar(acc) {
    const provider = providerOf(acc);
    const a = el("div", "avatar" + (acc.isActive ? " active" : "") + (acc.needsReauthorization ? " expired" : ""));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "provider-mark");
    svg.innerHTML = provider.glyph;
    a.style.setProperty("--avatar-color", AVATAR_COLORS[avatarState(acc)]);
    a.appendChild(svg);
    a.title = `${provider.name} account: ${acc.label}${acc.isActive ? " (active)" : ""} — ${avatarDescription(acc)}`;
    a.setAttribute("aria-hidden", "true");
    return a;
  }

  /** Quick actions shown left of the card's "..." menu: switch (inactive accounts only) and refresh. */
  function quickButtons(acc) {
    const buttons = [];
    if (acc.needsReauthorization) {
      // Switching would fail with a dead login; offer the fix instead.
      buttons.push(
        iconButton("key", "Login expired: reauthorize this account", () => post("reauthorize", acc.id), "quick reauth")
      );
    } else if (!acc.isActive) {
      buttons.push(iconButton("swap", "Switch to this account", () => post("switch", acc.id), "quick switch"));
    }
    buttons.push(iconButton("refresh", "Refresh usage", () => post("refresh", acc.id), "quick refresh"));
    return buttons;
  }

  // ---- dropdown menu ----------------------------------------------------

  function accountMenuItems(acc) {
    const act = (type) => () => post(type, acc.id);
    const items = [];
    if (!acc.isActive) items.push({ icon: "swap", label: "Switch to this account", run: act("switch") });
    items.push({ icon: "window", label: "Open in independent window", run: act("openWindow") });
    if (!acc.isActive) items.push({ icon: "hi", label: "Say Hi (warmup)", run: act("sayHi") });
    items.push({ icon: "refresh", label: "Refresh usage", run: act("refresh") });
    items.push(null);
    const accounts = state.accounts || [];
    const index = accounts.findIndex((a) => a.id === acc.id);
    if (filter.sort === "custom") {
      if (index > 0) items.push({ icon: "up", label: "Move up", run: () => move(acc.id, index - 1) });
      if (index >= 0 && index < accounts.length - 1) {
        items.push({ icon: "down", label: "Move down", run: () => move(acc.id, index + 1) });
      }
      if (accounts.length > 1) items.push(null);
    }
    items.push({
      icon: "key",
      label: "Reauthorize…",
      run: act("reauthorize"),
      accent: acc.needsReauthorization,
    });
    items.push({ icon: "edit", label: "Rename…", run: act("rename") });
    items.push({ icon: "trash", label: "Remove profile…", run: act("remove"), danger: true });
    return items;
  }

  /** Opens a dropdown under `anchor`; `items` are {icon, label, run, danger?, accent?} or null separators. */
  function toggleMenu(anchor, title, items) {
    if (menuAnchor === anchor) {
      closeMenu();
      return;
    }
    closeMenu();
    menuEl.innerHTML = "";
    menuEl.appendChild(el("div", "menu-title", title));

    for (const item of items) {
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
        item.run();
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

  // ---- reordering -------------------------------------------------------

  let dropTarget = null;

  /** Moves an account to `toIndex`, re-renders immediately and persists the order. */
  function move(id, toIndex) {
    const accounts = (state.accounts || []).slice();
    const from = accounts.findIndex((a) => a.id === id);
    if (from < 0) return;
    const [acc] = accounts.splice(from, 1);
    toIndex = Math.max(0, Math.min(accounts.length, toIndex));
    accounts.splice(toIndex, 0, acc);
    if (accounts.every((a, i) => a.id === state.accounts[i].id)) return;
    state = { ...state, accounts };
    render();
    vscode.postMessage({ type: "reorder", ids: accounts.map((a) => a.id) });
  }

  function clearDropMarker() {
    if (dropTarget) dropTarget.el.classList.remove("drop-before", "drop-after");
    dropTarget = null;
  }

  listEl.addEventListener("dragstart", (e) => {
    const cardEl = e.target.closest && e.target.closest(".card");
    if (!cardEl) return;
    closeMenu();
    dragId = cardEl.dataset.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragId);
    // Defer so the drag image is taken before the card fades.
    requestAnimationFrame(() => cardEl.classList.add("dragging"));
    listEl.classList.add("is-dragging");
  });

  listEl.addEventListener("dragover", (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const cardEl = e.target.closest && e.target.closest(".card");
    if (!cardEl || cardEl.dataset.id === dragId) {
      if (cardEl) clearDropMarker();
      return;
    }
    const r = cardEl.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    if (dropTarget && dropTarget.el === cardEl && dropTarget.before === before) return;
    clearDropMarker();
    cardEl.classList.add(before ? "drop-before" : "drop-after");
    dropTarget = { el: cardEl, before };
  });

  listEl.addEventListener("drop", (e) => {
    if (!dragId) return;
    e.preventDefault();
    if (dropTarget) {
      const accounts = state.accounts || [];
      const targetIndex = accounts.findIndex((a) => a.id === dropTarget.el.dataset.id);
      const fromIndex = accounts.findIndex((a) => a.id === dragId);
      let to = targetIndex + (dropTarget.before ? 0 : 1);
      if (fromIndex < to) to -= 1;
      const id = dragId;
      endDrag();
      move(id, to);
    } else {
      endDrag();
    }
  });

  listEl.addEventListener("dragend", endDrag);

  function endDrag() {
    clearDropMarker();
    dragId = null;
    listEl.classList.remove("is-dragging");
    for (const c of listEl.querySelectorAll(".dragging")) c.classList.remove("dragging");
    if (pendingRender) {
      pendingRender = false;
      render();
    }
  }

  // ---- render -----------------------------------------------------------

  // ---- filters and sorting ------------------------------------------------
  // The rules (what matches, how each sort orders) live in src/listing.ts, shared
  // with the availability calendar.

  const filtersEl = document.getElementById("filters");
  const searchInput = document.getElementById("searchInput");
  const clearFiltersBtn = document.getElementById("clearFilters");
  const noMatchEl = document.getElementById("noMatch");
  let filter = normalizeListing(vscode.getState());

  document.getElementById("searchIcon").appendChild(icon("search"));
  clearFiltersBtn.appendChild(icon("close"));
  searchInput.value = filter.text;

  /** The choices worth keeping (and backing up); the search text is transient. */
  function persistedFilter() {
    const { text: _text, ...rest } = filter;
    return rest;
  }

  /** Reports the choices (and, in memory only, the search text) so other views can start from them. */
  function reportFilter() {
    vscode.postMessage({ type: "viewSettings", settings: persistedFilter(), text: filter.text });
  }

  function setFilter(next) {
    filter = { ...filter, ...next };
    vscode.setState(filter);
    reportFilter();
    render();
  }

  /**
   * The extension keeps the sort and filter choices (so backups include them).
   * Adopt them on the first state and after a restore; otherwise hand it ours.
   */
  let appliedSettingsRev;
  function syncViewSettings(msg) {
    if (appliedSettingsRev === msg.viewSettingsRev) return;
    const first = appliedSettingsRev === undefined;
    appliedSettingsRev = msg.viewSettingsRev;
    const incoming = msg.viewSettings || {};
    if (first && Object.keys(incoming).length === 0) {
      reportFilter();
      return;
    }
    const { limit, plan, scope, sort } = normalizeListing(incoming);
    filter = { ...filter, limit, plan, scope, sort };
    vscode.setState(filter);
    reportFilter();
  }

  function clearFilters() {
    searchInput.value = "";
    setFilter({ text: "", limit: "all", plan: "all", scope: "any" });
  }

  searchInput.addEventListener("input", () => setFilter({ text: searchInput.value }));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchInput.value) {
      e.stopPropagation();
      clearFilters();
    }
  });
  for (const b of filtersEl.querySelectorAll("[data-filter]")) {
    b.addEventListener("click", () => setFilter({ limit: b.dataset.filter }));
  }
  clearFiltersBtn.addEventListener("click", clearFilters);

  const moreFiltersBtn = document.getElementById("moreFiltersBtn");
  moreFiltersBtn.appendChild(icon("funnel"));
  moreFiltersBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const accounts = state.accounts || [];
    const plans = [...new Set(accounts.map(planOf))].sort();
    const scopes = {};
    for (const acc of accounts) Object.assign(scopes, scopesOf(acc));
    const pick = (on) => (on ? "check" : "blank");
    const items = [{ icon: pick(filter.plan === "all"), label: "Any plan", run: () => setFilter({ plan: "all" }) }];
    for (const plan of plans) {
      items.push({ icon: pick(filter.plan === plan), label: planName(plan), run: () => setFilter({ plan }) });
    }
    items.push(null);
    items.push({ icon: pick(filter.scope === "any"), label: "Any model limits", run: () => setFilter({ scope: "any" }) });
    for (const [key, name] of Object.entries(scopes).sort()) {
      for (const [mode, text] of [["has", `With ${name} limit`], ["no", `Without ${name} limit`]]) {
        const scope = `${mode}:${key}`;
        items.push({ icon: pick(filter.scope === scope), label: text, run: () => setFilter({ scope }) });
      }
    }
    toggleMenu(moreFiltersBtn, "Filter accounts", items);
  });

  const sortBtn = document.getElementById("sortBtn");
  sortBtn.appendChild(icon("sort"));
  sortBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(
      sortBtn,
      "Sort accounts",
      SORTS.map((s) => ({
        icon: s.key === filter.sort ? "check" : "blank",
        label: s.label,
        run: () => setFilter({ sort: s.key }),
      }))
    );
  });

  document.getElementById("noMatchClear").addEventListener("click", clearFilters);

  /** Filters and sorting only matter with more than one account. */
  const MANY = 2;

  function renderFilterBar(total) {
    filtersEl.classList.toggle("hidden", total < MANY);
    for (const b of filtersEl.querySelectorAll("[data-filter]")) {
      const on = b.dataset.filter === filter.limit;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    const extra = extraFilterLabels(filter);
    moreFiltersBtn.classList.toggle("on", extra.length > 0);
    moreFiltersBtn.title = extra.length ? "Filter: " + extra.join(", ") : "Filter by plan or model limit";
    moreFiltersBtn.setAttribute("aria-label", moreFiltersBtn.title);
    clearFiltersBtn.classList.toggle("hidden", !filtersActive(filter));
    const sort = SORTS.find((s) => s.key === filter.sort) || SORTS[0];
    sortBtn.title = "Sort: " + sort.label;
    sortBtn.setAttribute("aria-label", sortBtn.title);
    sortBtn.classList.toggle("on", filter.sort !== "custom");
  }

  const sessionEl = document.getElementById("session");

  /** Info box for a Claude Code login that is not in the list (or no login at all). */
  /**
   * The Claude Code login of this window when it is not a saved account. With `welcome`
   * (no saved accounts yet) it is the panel's main card: the one thing to do is save it.
   */
  function sessionBox(session, welcome) {
    const box = el("div", "session " + session.status + (welcome ? " welcome" : ""));
    const head = el("div", "session-head");
    head.append(
      el("span", "session-kicker", welcome && session.status === "unsaved" ? "Claude Code is logged in as" : "Current Claude Code account (detected)")
    );
    if (session.subscriptionType) head.appendChild(el("span", "badge", session.subscriptionType));
    box.appendChild(head);

    if (session.status === "unsaved") {
      const usage = { windows: session.windows || [] };
      const tone = nameTone(usage);
      const name = el("div", "session-name" + (tone ? ` tone-${tone}` : ""), session.label || "Unidentified account");
      name.title = [name.textContent, nameToneDescription(usage), "Double-click to copy"].filter(Boolean).join("\n");
      if (session.label) copyOnDoubleClick(name); // no id: the unsaved current login
      box.appendChild(name);
      box.appendChild(
        el(
          "div",
          "session-note",
          welcome
            ? "Save it to start switching between accounts and tracking their limits. Its login stays as it is."
            : "Not in your account list yet."
        )
      );
      if (session.windows && session.windows.length) {
        const meters = el("div", "meters");
        for (const w of session.windows) meters.appendChild(meter(w, state.warnThreshold || 80));
        box.appendChild(meters);
      }
      const save = el("button", "tb-btn primary session-btn");
      save.append(icon("save"), el("span", "", welcome ? "Save this account" : "Save to account list"));
      save.addEventListener("click", () => post("add"));
      box.appendChild(save);
    } else {
      box.append(
        el("div", "session-name", "No account logged in"),
        el(
          "div",
          "session-note",
          welcome
            ? "Claude Code has no usable login in this window. Log in, or add an account below."
            : "Claude Code has no usable login in this window. Switch to a saved account or log in."
        )
      );
      const login = el("button", "tb-btn session-btn" + (welcome ? " primary" : ""));
      login.append(icon("signIn"), el("span", "", "Log in"));
      login.addEventListener("click", () => post("loginCurrent"));
      box.appendChild(login);
    }
    return box;
  }

  function render() {
    listEl.innerHTML = "";
    sessionEl.innerHTML = "";
    const accounts = state.accounts || [];
    const empty = accounts.length === 0;
    if (state.currentSession) sessionEl.appendChild(sessionBox(state.currentSession, empty));
    renderFilterBar(accounts.length);
    renderStats(accounts);
    // Analytics mean nothing before the first account; keep the tracking hint out of the empty state.
    document.getElementById("trackingNotice").classList.toggle("hidden", empty || state.trackingEnabled !== false);

    // With no accounts, the info box offers Add account and Restore; the toolbar would only repeat them.
    document.getElementById("toolbar").classList.toggle("hidden", empty);
    if (empty) {
      renderEmpty(state.currentSession);
      emptyEl.classList.remove("hidden");
      noMatchEl.classList.add("hidden");
      applyBusy();
      return;
    }
    emptyEl.classList.add("hidden");
    const order = new Map(accounts.map((a, i) => [a.id, i]));
    const visible = sortAccounts(accounts.filter((a) => matchesListing(a, filter)), order, filter.sort);
    noMatchEl.classList.toggle("hidden", visible.length > 0);
    for (const acc of visible) {
      listEl.appendChild(card(acc, state.warnThreshold || 80));
    }
    revealActiveChange(accounts);
    applyBusy();
    renderProposal();
  }

  /**
   * The empty state's text and buttons follow the detected login: with one, saving it (the
   * session card above) is the main action and Add / Restore are the alternatives; without
   * one, Add and Restore are the offer.
   */
  function renderEmpty(session) {
    const unsaved = session && session.status === "unsaved";
    document.getElementById("emptyTitle").textContent = unsaved ? "Or set up another account" : "No saved accounts";
    document.getElementById("emptyText").textContent = unsaved
      ? "Log in to a second account in an isolated login that does not touch the current one, or restore an account list from a backup."
      : session
        ? "Add an account by logging in, or restore an account list from a backup."
        : "Save the account Claude Code is logged in with, or log in to another one.";
    emptyEl.classList.toggle("secondary", Boolean(unsaved));
  }

  const statsEl = document.getElementById("stats");

  /** Footer chips: totals, availability, and free 5h / model-specific limits. */
  /**
   * When the earliest of `accounts` can use a limit again: "now" when one already
   * can, else the earliest reset of a used-up one; null when no account has it.
   */
  function nextAvailability(accounts, pick) {
    let earliest = Infinity;
    let any = false;
    let free = 0;
    for (const acc of accounts) {
      const windows = pick(acc);
      if (windows === null) continue;
      any = true;
      const blocked = windows.filter((w) => w.percent >= 100);
      if (blocked.length === 0) {
        free++;
        continue;
      }
      // Usable again once every used-up window has reset.
      const at = Math.max(...blocked.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : Infinity)));
      earliest = Math.min(earliest, Number.isFinite(at) ? at : Infinity);
    }
    if (!any) return null;
    return { now: free > 0, at: earliest, free };
  }

  /** Footer chips: shown/total, availability counts, and when each limit is next usable. */
  function renderStats(accounts) {
    statsEl.innerHTML = "";
    statsEl.classList.toggle("hidden", accounts.length < MANY);
    if (accounts.length < MANY) return;

    const visible = accounts.filter((a) => matchesListing(a, filter)).length;
    // An expired login cannot be used, whatever its last usage said.
    const usable = accounts.filter((a) => !a.needsReauthorization && (a.windows || []).length > 0);
    const count = (pred) => accounts.filter(pred).length;

    const countsRow = el("div", "stats-row");
    const nextRow = el("div", "stats-row");
    nextRow.appendChild(el("span", "stats-label", "Next available"));
    statsEl.append(countsRow, nextRow);
    let row = countsRow;
    const chip = (cls, title, ...parts) => {
      const c = el("span", "stat" + (cls ? " " + cls : ""));
      c.title = title;
      c.append(...parts);
      row.appendChild(c);
    };
    chip("", "Accounts shown by the current filters / all saved accounts", el("b", "", `${visible}/${accounts.length}`), el("span", "", " shown"));
    chip("ok", "Every limit below 100%", el("b", "", String(count((a) => !a.needsReauthorization && limitState(a) === "available"))), el("span", "", " available"));
    chip("danger", "At least one limit used up", el("b", "", String(count((a) => limitState(a) === "limited"))), el("span", "", " limited"));
    const expired = count((a) => a.needsReauthorization);
    if (expired > 0) {
      chip("warn", "Saved login expired or revoked; reauthorize these accounts", el("b", "", String(expired)), el("span", "", " login expired"));
    }

    // When is the next account usable: overall, then per limit.
    row = nextRow;
    const scopes = { fable: "Fable" };
    for (const acc of accounts) Object.assign(scopes, scopesOf(acc));
    const limits = [
      ["Any", "any account", (acc) => acc.windows],
      ["5h", "the 5-hour session limit", (acc) => byKind(acc, (k) => k === "session")],
      ["Weekly", "the weekly limit", (acc) => byKind(acc, (k) => k === "weekly_all")],
      ...Object.entries(scopes)
        .sort()
        .map(([key, name]) => [name, `the ${name} weekly limit`, (acc) => byKind(acc, (k) => k === `weekly_${key}`)]),
    ];
    for (const [name, what, pick] of limits) {
      const next = nextAvailability(usable, pick);
      let value, cls, title;
      if (!next) {
        value = "-";
        cls = "muted";
        title = `No account reports ${what}`;
      } else if (next.now) {
        value = "Now";
        cls = "ok";
        title = `${next.free} of the usable accounts can use ${what} now`;
      } else if (Number.isFinite(next.at)) {
        value = fmtDuration(Math.max(0, next.at - Date.now()));
        cls = "danger";
        title = `Every account has used up ${what}; the first is usable again at ${new Date(next.at).toLocaleString()}`;
      } else {
        value = "?";
        cls = "danger";
        title = `Every account has used up ${what}; reset time unknown`;
      }
      chip("next " + cls, title, el("span", "", name + " "), el("b", "", value));
    }
  }

  /** The account's windows matching `test` by kind, or null when it has none. */
  function byKind(acc, test) {
    const windows = (acc.windows || []).filter((w) => test(w.kind || ""));
    return windows.length ? windows : null;
  }

  // ---- proposing an account ----------------------------------------------

  const proposeBar = document.getElementById("proposeBar");
  const proposalEl = document.getElementById("proposal");
  let shownProposal = null; // { kind, automatic }

  for (const b of proposeBar.querySelectorAll("[data-propose]")) {
    b.addEventListener("click", () => showProposal(b.dataset.propose, false));
  }

  /** Shows the best account for `kind` with a one-sentence reason and a Switch button. */
  function showProposal(kind, automatic) {
    shownProposal = { kind, automatic };
    renderProposal();
    proposalEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function hideProposal() {
    shownProposal = null;
    renderProposal();
  }

  function renderProposal() {
    proposalEl.innerHTML = "";
    const accounts = state.accounts || [];
    // A Propose button is only worth showing when it can propose another account: one that is
    // usable for that limit and is not the active one.
    const worthIt = (kind) => rankAccounts(accounts, kind).some((a) => !a.isActive);
    const regular = worthIt("session");
    const fable = accounts.some((a) => (a.windows || []).some((w) => w.kind === "weekly_fable")) && worthIt("weekly_fable");
    proposeBar.classList.toggle("hidden", !regular && !fable);
    proposeBar.querySelector("[data-propose=session]").classList.toggle("hidden", !regular);
    proposeBar.querySelector("[data-propose=weekly_fable]").classList.toggle("hidden", !fable);
    if (shownProposal && !shownProposal.automatic && ((shownProposal.kind === "session" && !regular) || (shownProposal.kind === "weekly_fable" && !fable))) {
      shownProposal = null;
    }
    if (!shownProposal || accounts.length === 0) {
      proposalEl.classList.add("hidden");
      return;
    }
    const { kind, automatic } = shownProposal;
    const name = limitName(kind);
    const result = propose(accounts, kind);
    proposalEl.classList.remove("hidden");
    proposalEl.className = "proposal " + (result ? "notice info" : "notice warn");

    const body = el("div", "proposal-body");
    const head = el("div", "proposal-head");
    head.appendChild(
      el("span", "proposal-kicker", automatic ? `Your ${name} limit is used up — next accounts` : `Proposed accounts for ${name}`)
    );
    head.appendChild(iconButton("close", "Dismiss", hideProposal, "proposal-close"));
    body.appendChild(head);

    if (!result) {
      body.appendChild(el("div", "proposal-reason", noProposalReason(accounts, kind)));
    } else {
      const list = el("ol", "proposal-list");
      result.candidates.forEach((cand, i) => {
        const item = el("li", "proposal-item" + (i === 0 ? " best" : ""));
        const row = el("div", "proposal-row");
        const who = el("div", "proposal-name");
        who.append(el("span", "proposal-rank", String(i + 1)), avatar(cand.account), el("span", "", cand.account.label));
        row.appendChild(who);
        if (!cand.account.isActive) {
          const sw = el("button", "tb-btn proposal-switch" + (i === 0 ? " primary" : ""));
          sw.append(icon("swap"), el("span", "", "Switch"));
          sw.title = `Switch Claude Code to ${cand.account.label}`;
          sw.addEventListener("click", () => {
            post("switch", cand.account.id);
            hideProposal();
          });
          row.appendChild(sw);
        } else {
          row.appendChild(el("span", "proposal-active", "active"));
        }
        item.appendChild(row);
        // The limit this proposal is about, as the card's usage bar.
        const w = (cand.account.windows || []).find((x) => x.kind === kind);
        if (w) {
          const meters = el("div", "meters proposal-meters");
          meters.appendChild(meter(w, state.warnThreshold || 80));
          item.appendChild(meters);
        }
        item.appendChild(el("div", "proposal-reason", cand.reason));
        list.appendChild(item);
      });
      body.appendChild(list);
    }
    proposalEl.append(icon(result ? "info" : "warning"), body);
  }

  /** Top progress bar while anything loads; shimmer and a spinning refresh icon on updating cards. */
  function applyBusy() {
    const ids = new Set(busy.ids || []);
    progressEl.classList.toggle("hidden", !(busy.all || busy.session || ids.size > 0));
    for (const cardEl of listEl.querySelectorAll(".card")) {
      const on = ids.has(cardEl.dataset.id);
      cardEl.classList.toggle("busy", on);
      const refresh = cardEl.querySelector(".quick.refresh");
      if (refresh) refresh.classList.toggle("spin", on);
    }
    const sessionBoxEl = sessionEl.querySelector(".session");
    if (sessionBoxEl) sessionBoxEl.classList.toggle("busy", Boolean(busy.session));
  }

  /** When the detected login changes to a saved account, scroll to its card and flash it. */
  function revealActiveChange(accounts) {
    const active = accounts.find((a) => a.isActive);
    const activeId = active ? active.id : null;
    const changed = lastActiveId !== undefined && activeId !== lastActiveId;
    lastActiveId = activeId;
    if (!changed || !activeId) return;
    const cardEl = listEl.querySelector(`.card[data-id="${CSS.escape(activeId)}"]`);
    if (!cardEl) return;
    cardEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    cardEl.classList.add("flash");
    setTimeout(() => cardEl.classList.remove("flash"), 1600);
  }

  // Refresh countdowns every minute (but don't yank an open menu away).
  setInterval(() => {
    if (!menuAnchor && !dragId) render();
  }, 60000);

  vscode.postMessage({ type: "ready" });
})();
