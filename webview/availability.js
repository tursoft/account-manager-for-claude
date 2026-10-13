// Account availability calendar: a week (or one day) timeline per account, with
// an overall "usable?" lane and one lane per limit (5h, weekly, Fable, ...).
import { buildTimeline } from "../src/availability";
import { AVATAR_COLORS, avatarDescription, avatarState, starburstGlyph } from "../src/avatar";
import {
  DEFAULT_LISTING,
  filtersActive,
  matchesListing,
  normalizeListing,
  planName,
  planOf,
  scopesOf,
  SORTS,
  sortAccounts,
} from "../src/listing";

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STATE_TEXT = { free: "Available", high: "80%+ used", limited: "Limited", nodata: "No data" };

const saved = vscode.getState() || {};
// `off`: limit kinds whose lane is hidden (every other lane is shown).
const ui = { view: saved.view || "week", off: Array.isArray(saved.off) ? saved.off : [] };
// Sort and filters: the same rules as the accounts panel (src/listing.ts). The extension
// sends the panel's current choices when the page opens; from then on the page keeps its own.
let listing = { ...DEFAULT_LISTING };
let anchor = startOfDay(Date.now());
let data = null;

function persist() {
  vscode.setState({ view: ui.view, off: ui.off });
}

// ---- time helpers ------------------------------------------------------------

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday 00:00 of the week containing `t`. */
function startOfWeek(t) {
  const d = new Date(startOfDay(t));
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

function addDays(t, n) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function range() {
  if (ui.view === "day") return { from: anchor, to: addDays(anchor, 1) };
  const from = startOfWeek(anchor);
  return { from, to: addDays(from, 7) };
}

function fmtWhen(t) {
  return new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function shortLane(kind, label) {
  if (kind === "session") return "5h";
  if (kind === "weekly_all") return "Weekly";
  const scope = /\((.+)\)/.exec(label || "")?.[1];
  return scope || label || kind;
}

// ---- requests ------------------------------------------------------------

function request() {
  const { from, to } = range();
  vscode.postMessage({ type: "range", from, to });
}

$("prevBtn").addEventListener("click", () => {
  anchor = addDays(anchor, ui.view === "day" ? -1 : -7);
  request();
});
$("nextBtn").addEventListener("click", () => {
  anchor = addDays(anchor, ui.view === "day" ? 1 : 7);
  request();
});
$("todayBtn").addEventListener("click", () => {
  anchor = startOfDay(Date.now());
  request();
});
$("view").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (!b || b.dataset.view === ui.view) return;
  ui.view = b.dataset.view;
  persist();
  syncControls();
  request();
});

function syncControls() {
  for (const b of $("view").querySelectorAll("[data-view]")) {
    const on = b.dataset.view === ui.view;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}

// ---- sort and filters --------------------------------------------------------

const searchInput = $("searchInput");
const clearBtn = $("clearFilters");

for (const s of SORTS) {
  const o = document.createElement("option");
  o.value = s.key;
  o.textContent = s.label;
  $("sortSelect").appendChild(o);
}

function setListing(next) {
  listing = { ...listing, ...next };
  render();
}

function clearFilters() {
  searchInput.value = "";
  setListing({ text: "", limit: "all", plan: "all", scope: "any" });
}

searchInput.addEventListener("input", () => setListing({ text: searchInput.value }));
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && searchInput.value) clearFilters();
});
$("limitFilter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-limit]");
  if (b) setListing({ limit: b.dataset.limit });
});
$("planSelect").addEventListener("change", (e) => setListing({ plan: e.target.value }));
$("scopeSelect").addEventListener("change", (e) => setListing({ scope: e.target.value }));
$("sortSelect").addEventListener("change", (e) => setListing({ sort: e.target.value }));
clearBtn.addEventListener("click", clearFilters);

/** Replaces a select's options, but only when they changed, so an open select is not disturbed. */
function setOptions(select, options, value) {
  const key = options.map(([v]) => v).join("|");
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.innerHTML = "";
    for (const [v, text] of options) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = text;
      select.appendChild(o);
    }
  }
  select.value = value;
}

/** Brings the controls in line with `listing`; plan and model-limit choices come from the accounts. */
function syncListingControls(accounts) {
  if (searchInput.value !== listing.text) searchInput.value = listing.text;
  for (const b of $("limitFilter").querySelectorAll("[data-limit]")) {
    const on = b.dataset.limit === listing.limit;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }

  const plans = [...new Set(accounts.map(planOf))];
  if (listing.plan !== "all" && !plans.includes(listing.plan)) plans.push(listing.plan);
  setOptions(
    $("planSelect"),
    [["all", "Any plan"], ...plans.sort().map((p) => [p, planName(p)])],
    listing.plan
  );

  const scopes = {};
  for (const acc of accounts) Object.assign(scopes, scopesOf(acc));
  const scopeOptions = [["any", "Any model limit"]];
  for (const [key, name] of Object.entries(scopes).sort()) {
    scopeOptions.push([`has:${key}`, `With ${name} limit`], [`no:${key}`, `Without ${name} limit`]);
  }
  if (!scopeOptions.some(([v]) => v === listing.scope)) {
    const [mode, key] = listing.scope.split(":");
    scopeOptions.push([listing.scope, `${mode === "has" ? "With" : "Without"} ${key} limit`]);
  }
  setOptions($("scopeSelect"), scopeOptions, listing.scope);

  $("sortSelect").value = listing.sort;
  clearBtn.classList.toggle("hidden", !filtersActive(listing));
}

// ---- reordering (custom order only) --------------------------------------------
// Drag an account's label onto another account, or focus its grip and press Up / Down.
// This changes the saved custom order, the same order the accounts panel shows.

let dragId = null;
let dropTarget = null; // { el, before }
let pendingRender = false;
let focusGripId = null;
let shownIds = [];

function clearDropMarker() {
  if (dropTarget) dropTarget.el.classList.remove("drop-before", "drop-after");
  dropTarget = null;
}

/** Puts account `id` before or after account `targetId` in the full, saved order. */
function moveAccount(id, targetId, before) {
  const ids = data.accounts.map((a) => a.id);
  const from = ids.indexOf(id);
  const target = ids.indexOf(targetId);
  if (from < 0 || target < 0 || id === targetId) return;
  let to = target + (before ? 0 : 1);
  if (from < to) to -= 1;
  if (to === from) return;
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  const byId = new Map(data.accounts.map((a) => [a.id, a]));
  data = { ...data, accounts: ids.map((i) => byId.get(i)) };
  render();
  vscode.postMessage({ type: "reorder", ids });
}

function onGripKey(e, id) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  const i = shownIds.indexOf(id);
  const j = e.key === "ArrowUp" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= shownIds.length) return;
  focusGripId = id; // render() rebuilds the rows; put the focus back afterwards
  moveAccount(id, shownIds[j], e.key === "ArrowUp");
}

const calEl = $("calendar");

calEl.addEventListener("dragstart", (e) => {
  const label = e.target.closest && e.target.closest(".row-label[draggable='true']");
  const group = label && label.closest(".group");
  if (!group) return;
  dragId = group.dataset.id;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragId);
  e.dataTransfer.setDragImage(group, 24, 16);
  requestAnimationFrame(() => group.classList.add("dragging"));
});

calEl.addEventListener("dragover", (e) => {
  if (!dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const group = e.target.closest && e.target.closest(".group");
  if (!group || group.dataset.id === dragId) {
    clearDropMarker();
    return;
  }
  const r = group.getBoundingClientRect();
  const before = e.clientY < r.top + r.height / 2;
  if (dropTarget && dropTarget.el === group && dropTarget.before === before) return;
  clearDropMarker();
  group.classList.add(before ? "drop-before" : "drop-after");
  dropTarget = { el: group, before };
});

calEl.addEventListener("drop", (e) => {
  if (!dragId) return;
  e.preventDefault();
  const target = dropTarget;
  const id = dragId;
  endDrag();
  if (target) moveAccount(id, target.el.dataset.id, target.before);
});

calEl.addEventListener("dragend", endDrag);

function endDrag() {
  clearDropMarker();
  dragId = null;
  for (const g of calEl.querySelectorAll(".dragging")) g.classList.remove("dragging");
  if (pendingRender) {
    pendingRender = false;
    render();
  }
}

// ---- tooltip ---------------------------------------------------------------

const tip = $("tooltip");
document.addEventListener("mousemove", (e) => {
  const target = e.target.closest && e.target.closest("[data-tip]");
  if (!target) {
    tip.classList.add("hidden");
    return;
  }
  tip.textContent = target.dataset.tip;
  tip.classList.remove("hidden");
  const pad = 12;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = Math.min(e.clientX + pad, window.innerWidth - w - 4) + "px";
  tip.style.top = (e.clientY + pad + h > window.innerHeight ? e.clientY - h - pad : e.clientY + pad) + "px";
});

// ---- building blocks -------------------------------------------------------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Double-clicking an account's name copies it; the extension writes the clipboard and answers "copied". */
function copyOnDoubleClick(node, id) {
  node.addEventListener("mousedown", (e) => {
    if (e.detail > 1) e.preventDefault(); // no word selection on the second click
  });
  node.addEventListener("dblclick", () => vscode.postMessage({ type: "copyName", id }));
}

const toastEl = $("toast");
let toastTimer;

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

/** Round account icon: the Claude mark; green while the account has limit left, orange once a limit is used up. */
function avatar(acc) {
  const a = el("span", "avatar");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.innerHTML = starburstGlyph(12);
  a.style.setProperty("--avatar-color", AVATAR_COLORS[avatarState(acc)]);
  a.title = avatarDescription(acc);
  a.appendChild(svg);
  return a;
}

function pos(t, from, to) {
  return ((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100;
}

/** A track: positioned segments, reset markers, and the "now" mark. */
function track(segments, resets, from, to, now, name, thin) {
  const t = el("div", "track" + (thin ? " thin" : ""));
  t.style.setProperty("--cols", ui.view === "day" ? 24 : 7);
  for (const s of segments) {
    const slot = el("div", `slot ${s.state}${s.projected ? " projected" : ""}`);
    slot.style.left = pos(s.start, from, to) + "%";
    slot.style.width = Math.max(0.15, pos(s.end, from, to) - pos(s.start, from, to)) + "%";
    const pct = s.percent !== undefined && s.state !== "nodata" ? ` (${s.percent}%)` : "";
    slot.dataset.tip =
      `${name}: ${STATE_TEXT[s.state]}${pct}\n${fmtWhen(s.start)} – ${fmtWhen(s.end)}` +
      (s.projected ? "\nProjected from the latest reading" : "");
    t.appendChild(slot);
  }
  for (const r of resets || []) {
    if (r < from || r >= to) continue;
    const m = el("div", "reset");
    m.style.left = pos(r, from, to) + "%";
    m.dataset.tip = `${name} resets ${fmtWhen(r)}`;
    t.appendChild(m);
  }
  if (now >= from && now < to) {
    const n = el("div", "now-mark");
    n.style.left = pos(now, from, to) + "%";
    t.appendChild(n);
  }
  return t;
}

// ---- rendering -------------------------------------------------------------

function renderNow(accounts, timelines, now) {
  const strip = $("now");
  strip.innerHTML = "";
  accounts.forEach((acc, i) => {
    const tl = timelines[i];
    const card = el("div", "now-card" + (acc.isActive ? " active" : ""));
    const head = el("div", "now-head");
    head.append(avatar(acc));
    const name = el("div", "now-name", acc.label);
    name.title = `${acc.label}\nDouble-click to copy`;
    copyOnDoubleClick(name, acc.id);
    head.appendChild(name);
    if (acc.subscriptionType) head.appendChild(el("span", "badge", acc.subscriptionType));
    card.appendChild(head);

    let status;
    if (acc.needsReauthorization) {
      status = el("div", "now-status warn", "Login expired — reauthorize");
    } else if (tl.nextAvailableAt === null) {
      status = el("div", "now-status muted", acc.windows.length ? "Reset time unknown" : "No usage data yet");
    } else if (tl.nextAvailableAt <= now) {
      status = el("div", "now-status ok", acc.isActive ? "Available now · active" : "Available now");
    } else {
      status = el("div", "now-status bad", `Usable in ${fmtDuration(tl.nextAvailableAt - now)}`);
      status.title = `Usable again ${new Date(tl.nextAvailableAt).toLocaleString()}`;
      status.appendChild(el("span", "when", ` · ${fmtWhen(tl.nextAvailableAt)}`));
    }
    card.appendChild(status);

    const pills = el("div", "pills");
    for (const w of acc.windows) {
      const state = w.percent >= 100 ? "limited" : w.percent >= 80 ? "high" : "free";
      const pill = el("span", "pill " + state, `${shortLane(w.kind, w.label)} ${w.percent}%`);
      pill.title = w.resetsAt ? `${w.label}: ${w.percent}% · resets ${new Date(w.resetsAt).toLocaleString()}` : `${w.label}: ${w.percent}%`;
      pills.appendChild(pill);
    }
    card.appendChild(pills);

    if (!acc.isActive && !acc.needsReauthorization && tl.nextAvailableAt !== null && tl.nextAvailableAt <= now) {
      const sw = el("button", "switch", "Switch");
      sw.title = `Switch Claude Code to ${acc.label}`;
      sw.addEventListener("click", () => vscode.postMessage({ type: "switch", id: acc.id }));
      card.appendChild(sw);
    }
    strip.appendChild(card);
  });
}

function renderHead(from, to, now) {
  const head = el("div", "row head-row");
  head.appendChild(el("div", "row-label corner", ui.view === "day" ? "Hour" : "Day"));
  const cells = el("div", "head-cells");
  cells.style.setProperty("--cols", ui.view === "day" ? 24 : 7);
  if (ui.view === "week") {
    for (let d = 0; d < 7; d++) {
      const start = addDays(from, d);
      const date = new Date(start);
      const cell = el("button", "head-cell" + (start === startOfDay(now) ? " today" : "") + (date.getDay() % 6 === 0 ? " weekend" : ""));
      cell.title = "Show this day hour by hour";
      cell.append(
        el("span", "dow", date.toLocaleDateString([], { weekday: "short" })),
        el("span", "dom", String(date.getDate()))
      );
      const ticks = el("span", "ticks");
      for (const hr of [6, 12, 18]) {
        const tk = el("span", "tick", String(hr).padStart(2, "0"));
        tk.style.left = (hr / 24) * 100 + "%";
        ticks.appendChild(tk);
      }
      cell.appendChild(ticks);
      cell.addEventListener("click", () => {
        anchor = start;
        ui.view = "day";
        persist();
        syncControls();
        request();
      });
      cells.appendChild(cell);
    }
  } else {
    for (let hr = 0; hr < 24; hr++) {
      const start = from + hr * HOUR;
      const cell = el("div", "head-cell hour" + (now >= start && now < start + HOUR ? " today" : ""));
      cell.appendChild(el("span", "dom", String(hr).padStart(2, "0")));
      cells.appendChild(cell);
    }
  }
  if (now >= from && now < to) {
    const n = el("div", "now-label", "Now");
    n.style.left = pos(now, from, to) + "%";
    cells.appendChild(n);
  }
  head.appendChild(cells);
  return head;
}

/** Limits offered as checkboxes: 5h and Fable always, other kinds (weekly, ...) once an account has them. */
function limitOptions(timelines) {
  const options = new Map([
    ["session", "5h"],
    ["weekly_fable", "Fable"],
  ]);
  for (const tl of timelines) {
    for (const lane of tl.lanes) {
      if (!options.has(lane.kind)) options.set(lane.kind, shortLane(lane.kind, lane.label));
    }
  }
  const rank = (kind) => (kind === "session" ? 0 : kind === "weekly_all" ? 1 : 2);
  return [...options.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[1].localeCompare(b[1]));
}

let checksKey = "";

/** Builds the checkboxes; rebuilt only when the set of limits changes, so a focused box stays focused. */
function renderLimitChecks(options) {
  const key = options.map(([kind]) => kind).join("|");
  if (key === checksKey) return;
  checksKey = key;
  const box = $("limitChecks");
  box.innerHTML = "";
  for (const [kind, text] of options) {
    const label = el("label", "check");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !ui.off.includes(kind);
    input.addEventListener("change", () => {
      ui.off = input.checked ? ui.off.filter((k) => k !== kind) : [...ui.off, kind];
      persist();
      render();
    });
    label.append(input, el("span", "", text));
    box.appendChild(label);
  }
}

function render() {
  if (!data) return;
  const { from, to, now, points, accounts } = data;

  const o = ui.view === "day"
    ? { weekday: "long", month: "long", day: "numeric", year: "numeric" }
    : { month: "short", day: "numeric" };
  $("rangeLabel").textContent =
    ui.view === "day"
      ? new Date(from).toLocaleDateString([], o)
      : `${new Date(from).toLocaleDateString([], o)} – ${new Date(to - 1).toLocaleDateString([], { ...o, year: "numeric" })}`;

  // Timelines for every account (the limit checkboxes and the filter options come from all
  // of them); only the accounts passing the filters are shown, in the chosen order.
  const timelines = new Map(accounts.map((acc) => [acc.id, buildTimeline(acc, points, from, to, now)]));
  const order = new Map(accounts.map((acc, i) => [acc.id, i]));
  const visible = sortAccounts(
    accounts.filter((acc) => matchesListing(acc, listing)),
    order,
    listing.sort
  );
  const options = limitOptions([...timelines.values()]);
  renderLimitChecks(options);
  // Which bars sit beside the account's name:
  //  - exactly one limit ticked: that limit's bar (there is nothing else to show);
  //  - several ticked: none, the name row stays bare and each ticked limit has its own lane below;
  //  - none ticked: the overall bar ("is any limit blocking?"), so the row is not empty.
  const ticked = options.filter(([kind]) => !ui.off.includes(kind));
  const single = ticked.length === 1 ? ticked[0] : null; // [kind, text]
  syncListingControls(accounts);
  renderNow(visible, visible.map((acc) => timelines.get(acc.id)), now);

  const cal = $("calendar");
  cal.innerHTML = "";
  cal.appendChild(renderHead(from, to, now));
  if (accounts.length === 0) {
    cal.appendChild(el("div", "empty", "No saved accounts yet."));
    return;
  }
  if (visible.length === 0) {
    const empty = el("div", "empty");
    empty.append("No accounts match the filters. ");
    const clear = el("button", "link", "Clear filters");
    clear.addEventListener("click", clearFilters);
    empty.appendChild(clear);
    cal.appendChild(empty);
    return;
  }

  shownIds = visible.map((acc) => acc.id);
  visible.forEach((acc) => {
    const tl = timelines.get(acc.id);
    const group = el("div", "group" + (acc.needsReauthorization ? " expired" : ""));
    group.dataset.id = acc.id;
    const bare = ticked.length > 1 && tl.lanes.some((l) => !ui.off.includes(l.kind));
    const row = el("div", "row overall-row" + (bare ? " bare" : ""));
    const label = el("div", "row-label");
    if (listing.sort === "custom") {
      // Only in the user's own order does moving an account mean anything.
      label.classList.add("reorderable");
      label.draggable = true;
      const grip = el("button", "grip");
      grip.type = "button";
      grip.title = "Drag to reorder, or press the Up / Down arrow key";
      grip.setAttribute("aria-label", `Reorder ${acc.label}: press the Up or Down arrow key to move it`);
      grip.addEventListener("keydown", (e) => onGripKey(e, acc.id));
      label.appendChild(grip);
    }
    label.append(avatar(acc));
    const name = el("span", "name", acc.label);
    name.title =
      (acc.subscriptionType ? `${acc.label} (${acc.subscriptionType})` : acc.label) + "\nDouble-click to copy";
    copyOnDoubleClick(name, acc.id);
    label.appendChild(name);
    let main = null;
    if (single) {
      const lane = tl.lanes.find((l) => l.kind === single[0]);
      main = lane
        ? track(lane.segments, lane.resets, from, to, now, `${acc.label} · ${lane.label}`, false)
        : el("div", "track-empty", `No ${single[1]} limit`);
    } else if (ticked.length === 0) {
      main = track(tl.overall, [], from, to, now, `${acc.label} (any limit)`, false);
    } else if (!bare) {
      // Several limits ticked, but this account has none of them.
      main = el("div", "track-empty", `No ${ticked.map(([, text]) => text).join(" or ")} limit`);
    }
    row.appendChild(label);
    if (main) row.appendChild(main);
    group.appendChild(row);

    if (ticked.length > 1) {
      for (const lane of tl.lanes) {
        if (ui.off.includes(lane.kind)) continue;
        const r = el("div", "row lane-row");
        r.append(
          el("div", "row-label lane-label", shortLane(lane.kind, lane.label)),
          track(lane.segments, lane.resets, from, to, now, `${acc.label} · ${lane.label}`, true)
        );
        group.appendChild(r);
      }
    }
    cal.appendChild(group);
  });

  if (focusGripId) {
    const grip = cal.querySelector(`.group[data-id="${CSS.escape(focusGripId)}"] .grip`);
    focusGripId = null;
    if (grip) grip.focus();
  }
}

// ---- messages --------------------------------------------------------------

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "init") {
    listing = normalizeListing(msg.listing);
    syncListingControls(data ? data.accounts : []);
    request();
  } else if (msg.type === "copied") {
    showToast(msg.ok ? `Copied “${msg.name}”` : "Could not copy to the clipboard");
  } else if (msg.type === "data") {
    data = msg;
    // Re-rendering mid-drag would destroy the dragged row; catch up when the drag ends.
    if (dragId) pendingRender = true;
    else render();
  } else if (msg.type === "changed") {
    request();
  }
});

// The "now" line moves; reload every minute.
setInterval(request, 60_000);

syncControls();
renderLimitChecks(limitOptions([]));
syncListingControls([]);
// The extension answers with the accounts panel's sort and filters; the first data request follows.
vscode.postMessage({ type: "ready" });
