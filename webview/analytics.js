// Usage analytics page: charts of the collected usage history, one chart per
// limit kind (5h session, weekly, Fable, ...), for one or more accounts.
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PieController,
  PointElement,
  Tooltip,
} from "chart.js";
import { bucketSeries, bucketSizeFor, bucketStarts, kindsIn, seriesTotal } from "../src/historySeries";
import { cycleMs, utilizationSeries, utilizationSummary } from "../src/utilization";

Chart.register(
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PieController,
  PointElement,
  Tooltip
);

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

// Same palette as the accounts panel's avatar rings, in account order.
const COLORS = ["#4c9aff", "#a371f7", "#2bc4c4", "#e86bb0", "#e3b341", "#7c83ff", "#a5d64c", "#56d4f5", "#c678dd", "#f0883e"];
const DAY = 86_400_000;
const RANGES = { "1d": DAY, "1w": 7 * DAY, "1m": 30 * DAY, "3m": 90 * DAY };

const saved = vscode.getState() || {};
const ui = {
  range: saved.range || "1w",
  mode: saved.mode === "available" ? "available" : "used", // older saved states used "limit" / "usage"
  chartType: saved.chartType || "line",
  selected: saved.selected || null, // null = all accounts
  customFrom: saved.customFrom || null,
  customTo: saved.customTo || null,
};
let meta = { enabled: false, intervalSeconds: 60, retentionDays: 90, accounts: [] };
let data = null; // { from, to, points, accounts }
let charts = [];
let reloadTimer = null;
let loadedAt = null; // when the data on screen was fetched

/** Reloads every 2 minutes, so the page follows the collection without being touched. */
const AUTO_REFRESH_MS = 2 * 60_000;
setInterval(() => {
  if (currentRange().live) requestData();
}, AUTO_REFRESH_MS);

/** "updated 12s ago" next to the Refresh button; ticks every 10 s. */
function renderUpdated() {
  const el = $("updatedText");
  if (loadedAt === null) {
    el.textContent = "";
    return;
  }
  const s = Math.max(0, Math.round((Date.now() - loadedAt) / 1000));
  el.textContent = s < 60 ? `updated ${s}s ago` : `updated ${Math.round(s / 60)}m ago`;
}
setInterval(renderUpdated, 10_000);

function persist() {
  vscode.setState(ui);
}

// ---- range ---------------------------------------------------------------

function currentRange() {
  const now = Date.now();
  if (ui.range === "custom" && ui.customFrom && ui.customTo) {
    return { from: ui.customFrom, to: Math.min(ui.customTo, now), live: ui.customTo >= now };
  }
  if (ui.range === "all") {
    return { from: now - meta.retentionDays * DAY, to: now, live: true };
  }
  return { from: now - (RANGES[ui.range] || RANGES["1w"]), to: now, live: true };
}

function requestData() {
  const { from, to } = currentRange();
  vscode.postMessage({ type: "query", from, to });
}

function toLocalInput(t) {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

// ---- controls ------------------------------------------------------------

function setSeg(container, attr, value) {
  for (const b of container.querySelectorAll(`[data-${attr}]`)) {
    const on = b.dataset[attr] === value;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}

$("range").addEventListener("click", (e) => {
  const b = e.target.closest("[data-range]");
  if (!b) return;
  ui.range = b.dataset.range;
  if (ui.range === "custom" && !(ui.customFrom && ui.customTo)) {
    ui.customTo = Date.now();
    ui.customFrom = ui.customTo - 7 * DAY;
  }
  persist();
  syncControls();
  requestData();
});

for (const id of ["fromInput", "toInput"]) {
  $(id).addEventListener("change", () => {
    const from = Date.parse($("fromInput").value);
    const to = Date.parse($("toInput").value);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      ui.customFrom = from;
      ui.customTo = to;
      persist();
      requestData();
    }
  });
}

$("mode").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (!b) return;
  ui.mode = b.dataset.mode;
  persist();
  syncControls();
  render();
});

$("chartType").addEventListener("change", (e) => {
  ui.chartType = e.target.value;
  persist();
  render();
});

$("allBtn").addEventListener("click", () => {
  ui.selected = null;
  persist();
  render();
});

$("noneBtn").addEventListener("click", () => {
  ui.selected = [];
  persist();
  render();
});

$("refreshBtn").addEventListener("click", () => {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  $("refreshBtn").classList.add("spin");
  requestData();
});
$("collectToggle").addEventListener("change", (e) =>
  vscode.postMessage({ type: "setHistory", enabled: e.target.checked })
);

function syncControls() {
  setSeg($("range"), "range", ui.range);
  setSeg($("mode"), "mode", ui.mode);
  $("chartType").value = ui.chartType;
  $("custom").classList.toggle("hidden", ui.range !== "custom");
  if (ui.range === "custom" && ui.customFrom && ui.customTo) {
    $("fromInput").value = toLocalInput(ui.customFrom);
    $("toInput").value = toLocalInput(ui.customTo);
  }
}

// ---- accounts ------------------------------------------------------------

/** Saved accounts first (panel order), then accounts only found in the history. */
function allAccounts() {
  const list = (data?.accounts || meta.accounts).map((a, i) => ({ ...a, color: COLORS[i % COLORS.length] }));
  const known = new Set(list.map((a) => a.id));
  for (const p of data?.points || []) {
    if (known.has(p.id)) continue;
    known.add(p.id);
    list.push({ id: p.id, label: (p.label || p.id.slice(0, 8)) + " (removed)", plan: p.plan, color: COLORS[list.length % COLORS.length] });
  }
  return list;
}

function isSelected(id) {
  return ui.selected === null || ui.selected.includes(id);
}

/**
 * The one legend for all charts: a vertical list at the left. Clicking an account
 * shows or hides its data in every chart.
 */
function renderLegend(accounts, hasData) {
  $("accounts").innerHTML = "";
  for (const acc of accounts) {
    const visible = isSelected(acc.id);
    // A label around a real checkbox: keyboard and screen-reader friendly, and the name
    // carries the account's chart color so the legend and the charts read the same.
    const item = document.createElement("label");
    item.className = "legend-item" + (visible ? "" : " off");
    item.style.setProperty("--c", acc.color);
    item.title = (acc.plan ? `${acc.label} (${acc.plan})` : acc.label) + (visible ? "\nUntick to hide" : "\nTick to show");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = visible;
    box.setAttribute("aria-label", `Show ${acc.label} in the charts`);
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = acc.label;
    const meta = [acc.plan, hasData.has(acc.id) ? null : "no data in range"].filter(Boolean).join(" · ");
    if (meta) {
      const m = document.createElement("span");
      m.className = "meta";
      m.textContent = meta;
      text.appendChild(m);
    }
    item.append(box, text);
    box.addEventListener("change", () => {
      const ids = ui.selected === null ? accounts.map((a) => a.id) : ui.selected.slice();
      const i = ids.indexOf(acc.id);
      if (i >= 0) ids.splice(i, 1);
      else ids.push(acc.id);
      ui.selected = ids.length === accounts.length ? null : ids;
      persist();
      render();
    });
    $("accounts").appendChild(item);
  }
}

// ---- rendering -------------------------------------------------------------

function cssVar(name, fallback) {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

function fmtBucket(t, rangeMs) {
  const d = new Date(t);
  if (rangeMs <= DAY) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (rangeMs <= 8 * DAY) {
    return d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtRange(from, to) {
  const o = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  return `${new Date(from).toLocaleString([], o)} – ${new Date(to).toLocaleString([], o)}`;
}

function render() {
  for (const c of charts) c.destroy();
  charts = [];
  $("charts").innerHTML = "";
  $("utilCharts").innerHTML = "";
  $("utilSummary").innerHTML = "";

  const accounts = allAccounts();
  renderLegend(accounts, new Set(data ? data.points.filter((p) => p.t >= data.from).map((p) => p.id) : []));
  if (!data) return;

  const { from, to } = data;
  $("rangeText").textContent = fmtRange(from, to);
  const rangeMs = to - from;
  const points = data.points;
  const inRange = points.filter((p) => p.t >= from);
  const selected = accounts.filter((a) => isSelected(a.id));
  const kinds = kindsIn(points);

  const empty = $("emptyNotice");
  if (inRange.length === 0 || selected.length === 0 || kinds.length === 0) {
    empty.classList.remove("hidden");
    $("emptyText").textContent =
      selected.length === 0
        ? "No accounts selected. Click accounts in the legend to show them."
        : meta.enabled
          ? "No readings in this range yet. Data appears as usage is collected."
          : "No readings in this range. Turn on usage collection to start recording.";
    return;
  }
  empty.classList.add("hidden");

  const bucketMs = bucketSizeFor(rangeMs);
  const starts = bucketStarts(from, to, bucketMs);
  const labels = starts.map((t) => fmtBucket(t, rangeMs));
  const text = cssVar("--vscode-foreground", "#ccc");
  const muted = cssVar("--vscode-descriptionForeground", "#999");
  const grid = cssVar("--vscode-editorWidget-border", "rgba(128,128,128,0.25)");
  const isPie = ui.chartType === "pie" || ui.chartType === "doughnut";

  for (const { kind, label } of kinds) {
    const card = document.createElement("div");
    card.className = "card chart-card";
    const head = document.createElement("div");
    head.className = "chart-head";
    const title = document.createElement("h2");
    title.textContent = label;
    const sub = document.createElement("span");
    sub.className = "caption";
    const used = ui.mode === "used";
    sub.textContent = isPie
      ? `Average % ${used ? "used" : "available"} in the range, per account`
      : used
        ? `Highest % used per ${fmtDuration(bucketMs)}`
        : `Lowest % available per ${fmtDuration(bucketMs)}`;
    head.append(title, sub);
    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap" + (isPie ? " pie" : "");
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    card.append(head, wrap);
    $("charts").appendChild(card);

    const series = selected
      .map((acc) => ({ acc, values: bucketSeries(points, acc.id, kind, from, to, bucketMs, ui.mode) }))
      .filter((s) => s.values.some((v) => v !== null));

    if (series.length === 0) {
      wrap.classList.add("no-data");
      wrap.textContent = "No data for the selected accounts.";
      continue;
    }

    let config;
    if (isPie) {
      const totals = series.map((s) => ({ acc: s.acc, total: seriesTotal(s.values) ?? 0 }));
      config = {
        type: ui.chartType,
        data: {
          labels: totals.map((t) => t.acc.label),
          datasets: [
            {
              data: totals.map((t) => t.total),
              backgroundColor: totals.map((t) => t.acc.color),
              borderColor: cssVar("--vscode-editor-background", "#1e1e1e"),
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (c) => ` ${c.label}: ${c.parsed}%` } },
          },
        },
      };
    } else {
      const bar = ui.chartType === "bar" || ui.chartType === "stacked";
      const stacked = ui.chartType === "stacked";
      config = {
        type: bar ? "bar" : "line",
        data: {
          labels,
          datasets: series.map(({ acc, values }) => ({
            label: acc.label,
            data: values,
            borderColor: acc.color,
            backgroundColor: bar ? acc.color + "cc" : acc.color + "33",
            fill: ui.chartType === "area" ? "origin" : false,
            borderWidth: bar ? 0 : 2,
            borderRadius: bar ? 3 : 0,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.25,
            spanGaps: false,
            stepped: false,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          scales: {
            x: {
              stacked,
              ticks: { color: muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 18 },
              grid: { color: grid, display: false },
            },
            y: {
              stacked,
              // Always 0-100% (a limit is 100%). A stacked bar adds the accounts up, so it
              // keeps 0-100% as a minimum but may grow past it.
              min: 0,
              max: stacked ? undefined : 100,
              suggestedMax: stacked ? 100 : undefined,
              ticks: { color: muted, callback: (v) => v + "%" },
              grid: { color: grid },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (c) => (c.parsed.y === null ? null : ` ${c.dataset.label}: ${c.parsed.y}%`),
              },
            },
          },
        },
      };
    }
    charts.push(new Chart(canvas, config));
  }

  renderUtilization(kinds, selected, points, from, to, { text, muted, grid });
}

// ---- capacity utilization ----------------------------------------------------

/**
 * Chart buckets for utilization. Each bucket compares what was used in it with the share of
 * the cycle's budget it covers, so a bucket must hold a meaningful share: at least a day for
 * weekly limits (1/7 of the budget), at least an hour for the 5h limit; whole cycles once the
 * range spans several of them.
 */
function utilBucketMs(kind, rangeMs) {
  const cycle = cycleMs(kind);
  const floor = kind === "session" ? 3_600_000 : 86_400_000;
  if (rangeMs <= cycle * 2) return Math.max(floor, bucketSizeFor(rangeMs));
  return cycle * Math.max(1, Math.ceil(rangeMs / cycle / 120)); // keep it under ~120 bars
}

function utilTone(value) {
  return value === null ? "" : value >= 70 ? "good" : value >= 35 ? "mid" : "low";
}

function renderUtilization(kinds, selected, points, from, to, colors) {
  const rangeMs = to - from;
  const ids = selected.map((a) => a.id);
  const summaryBox = $("utilSummary");
  const summaries = kinds.map(({ kind, label }) => utilizationSummary(points, ids, kind, label, from, to));

  // One figure per limit, plus the whole: every limit's used budgets over every limit's offered budgets.
  const totalUsed = summaries.reduce((s, x) => s + x.usedBudgets, 0);
  const totalOffered = summaries.reduce((s, x) => s + x.offeredBudgets, 0);
  const overall = totalOffered > 0 ? Math.round((totalUsed / totalOffered) * 1000) / 10 : null;
  summaryBox.appendChild(
    utilFigure("All limits", overall, totalOffered > 0 ? `${totalUsed.toFixed(1)} of ${totalOffered.toFixed(1)} budgets used` : "no data", true)
  );
  for (const s of summaries) {
    summaryBox.appendChild(
      utilFigure(s.label, s.overall, s.overall === null ? "no data" : `${s.usedBudgets.toFixed(1)} of ${s.offeredBudgets.toFixed(1)} ${s.kind === "session" ? "5h" : "weekly"} budgets used`)
    );
  }

  for (const { kind, label } of kinds) {
    const bucketMs = utilBucketMs(kind, rangeMs);
    const series = utilizationSeries(points, ids, kind, from, to, bucketMs);
    if (!series.values.some((v) => v !== null)) continue;
    const summary = summaries.find((s) => s.kind === kind);

    const card = document.createElement("div");
    card.className = "card chart-card";
    const head = document.createElement("div");
    head.className = "chart-head";
    const title = document.createElement("h2");
    title.textContent = `${label} utilization`;
    const sub = document.createElement("span");
    sub.className = "caption";
    sub.textContent = `% of the capacity used per ${fmtDuration(bucketMs)}${summary && summary.overall !== null ? ` · ${summary.overall}% overall` : ""}`;
    head.append(title, sub);
    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap";
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    card.append(head, wrap);
    $("utilCharts").appendChild(card);

    const labels = series.starts.map((t) => fmtBucket(t, rangeMs));
    const datasets = [];
    if (ids.length > 1) {
      datasets.push({
        label: "Selected accounts together",
        data: series.values,
        borderColor: colors.text,
        backgroundColor: colors.text + "22",
        fill: "origin",
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.2,
        spanGaps: false,
        order: 0,
      });
    }
    selected.forEach((acc, i) => {
      if (!series.perAccount[i].some((v) => v !== null)) return;
      datasets.push({
        label: acc.label,
        data: series.perAccount[i],
        borderColor: acc.color,
        backgroundColor: acc.color + "22",
        fill: ids.length > 1 ? false : "origin",
        borderWidth: ids.length > 1 ? 1.25 : 2,
        borderDash: ids.length > 1 ? [4, 3] : [],
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.2,
        spanGaps: false,
        order: 1,
      });
    });

    charts.push(
      new Chart(canvas, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          scales: {
            x: { ticks: { color: colors.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 18 }, grid: { display: false } },
            y: { min: 0, max: 100, ticks: { color: colors.muted, callback: (v) => v + "%" }, grid: { color: colors.grid } },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (c) => (c.parsed.y === null ? null : ` ${c.dataset.label}: ${c.parsed.y}% of capacity used`),
              },
            },
          },
        },
      })
    );
  }
}

/** A figure card: the limit's name, its utilization, and what it is made of. */
function utilFigure(name, value, detail, primary) {
  const card = document.createElement("div");
  card.className = "card util-figure" + (primary ? " primary" : "") + (value === null ? "" : " " + utilTone(value));
  const n = document.createElement("div");
  n.className = "caption";
  n.textContent = name;
  const v = document.createElement("div");
  v.className = "util-value";
  v.textContent = value === null ? "–" : `${value}%`;
  const d = document.createElement("div");
  d.className = "caption";
  d.textContent = detail;
  card.append(n, v, d);
  return card;
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${m / 60} h`;
  return m === 1440 ? "day" : `${m / 1440} days`;
}

function renderStatus() {
  $("status").textContent = meta.enabled
    ? `Collecting every ${meta.intervalSeconds}s · keeping ${meta.retentionDays} days · stored only on this computer`
    : "Usage collection is off";
  $("collectToggle").checked = meta.enabled;
  $("offNotice").classList.toggle("hidden", meta.enabled);
}

// ---- messages --------------------------------------------------------------

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "meta") {
    meta = msg;
    renderStatus();
    requestData();
  } else if (msg.type === "data") {
    data = msg;
    loadedAt = Date.now();
    $("refreshBtn").classList.remove("spin");
    renderUpdated();
    render();
  } else if (msg.type === "newData") {
    // Only ranges that end now change with new readings; reload at most every 30 s.
    if (!currentRange().live || reloadTimer) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      requestData();
    }, 30_000);
  }
});

syncControls();
vscode.postMessage({ type: "ready" });
