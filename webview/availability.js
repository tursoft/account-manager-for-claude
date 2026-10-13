// Account availability calendar: a week (or one day) timeline per account, with
// an overall "usable?" lane and one lane per limit (5h, weekly, Fable, ...).
import { buildTimeline } from "../src/availability";

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STATE_TEXT = { free: "Available", high: "80%+ used", limited: "Limited", nodata: "No data" };

const saved = vscode.getState() || {};
const ui = { view: saved.view || "week", lanes: saved.lanes !== false };
let anchor = startOfDay(Date.now());
let data = null;

function persist() {
  vscode.setState({ view: ui.view, lanes: ui.lanes });
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
$("lanesToggle").addEventListener("change", (e) => {
  ui.lanes = e.target.checked;
  persist();
  render();
});
$("enableBtn").addEventListener("click", () => vscode.postMessage({ type: "enableHistory" }));

function syncControls() {
  for (const b of $("view").querySelectorAll("[data-view]")) {
    const on = b.dataset.view === ui.view;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
  $("lanesToggle").checked = ui.lanes;
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

function starburst() {
  let d = "";
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 ? 4.6 : 6.4;
    d += `M${(8 + Math.cos(a) * 1.4).toFixed(2)} ${(8 + Math.sin(a) * 1.4).toFixed(2)}L${(8 + Math.cos(a) * r).toFixed(2)} ${(8 + Math.sin(a) * r).toFixed(2)}`;
  }
  return `<path d="${d}"/>`;
}

function avatar() {
  const a = el("span", "avatar");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.innerHTML = starburst();
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
    head.append(avatar());
    const name = el("div", "now-name", acc.label);
    name.title = acc.label;
    head.appendChild(name);
    if (acc.plan) head.appendChild(el("span", "badge", acc.plan));
    card.appendChild(head);

    let status;
    if (acc.expired) {
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

    if (!acc.isActive && !acc.expired && tl.nextAvailableAt !== null && tl.nextAvailableAt <= now) {
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
  $("historyNotice").classList.toggle("hidden", data.historyEnabled || from >= now);

  const timelines = accounts.map((acc) => buildTimeline(acc, points, from, to, now));
  renderNow(accounts, timelines, now);

  const cal = $("calendar");
  cal.innerHTML = "";
  cal.appendChild(renderHead(from, to, now));
  if (accounts.length === 0) {
    cal.appendChild(el("div", "empty", "No saved accounts yet."));
    return;
  }

  accounts.forEach((acc, i) => {
    const tl = timelines[i];
    const group = el("div", "group" + (acc.expired ? " expired" : ""));
    const row = el("div", "row overall-row");
    const label = el("div", "row-label");
    label.append(avatar());
    const name = el("span", "name", acc.label);
    name.title = acc.plan ? `${acc.label} (${acc.plan})` : acc.label;
    label.appendChild(name);
    row.append(label, track(tl.overall, [], from, to, now, `${acc.label} (any limit)`, false));
    group.appendChild(row);

    if (ui.lanes) {
      for (const lane of tl.lanes) {
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
}

// ---- messages --------------------------------------------------------------

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "data") {
    data = msg;
    render();
  } else if (msg.type === "changed") {
    request();
  }
});

// The "now" line moves; reload every minute.
setInterval(request, 60_000);

syncControls();
request();
