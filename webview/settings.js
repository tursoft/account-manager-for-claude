// Settings page: every setting of the extension in sections, with its description. A change is
// sent as soon as it is complete (a switch flipped, a field left or Enter pressed); the extension
// checks it again, writes it to the user settings and sends the new values back.
import { checkSettingValue, controlOf, descriptionParts, formatSettingValue, rangeText } from "../src/settingsModel";

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

/**
 * key -> the setting's latest field from the extension and its elements. `dirty`: the field holds
 * typing that is not sent yet, which new values from the extension must not overwrite.
 */
const rows = new Map();
/** The settings the page was built for; it is built again only when they change. */
let builtFor = "";

// ---- building blocks -------------------------------------------------------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A setting's description: text, `code`, **bold**, and links to the other settings it names. */
function description(markdown) {
  const p = el("p", "row-desc");
  for (const part of descriptionParts(markdown)) {
    if (part.kind === "text") p.append(part.text);
    else if (part.kind === "code") p.append(el("code", "", part.text));
    else if (part.kind === "bold") p.append(el("b", "", part.text));
    else {
      // Its text comes from update(): the other setting's value, or its name for an on/off one.
      // A link, not a button: it stays inline, so "95" keeps to the "% used" after it.
      const ref = el("a", "ref");
      ref.href = "#";
      ref.dataset.key = part.key;
      ref.title = "Go to this setting";
      ref.addEventListener("click", (e) => {
        e.preventDefault();
        goTo(part.key);
      });
      p.append(ref);
    }
  }
  return p;
}

function buildRow(field) {
  const control = controlOf(field.schema);
  const id = "setting-" + field.key;
  const row = el("div", "row is-" + (control || "external"));
  const head = el("div", "row-head");
  const label = el("label", "row-label", field.label);
  head.append(label);

  let input = null;
  let box;
  if (control === "switch") {
    box = el("label", "switch");
    input = el("input");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    const track = el("span", "track");
    track.setAttribute("aria-hidden", "true");
    box.append(input, track);
  } else if (control === "number") {
    box = el("span", "number");
    input = el("input");
    input.type = "number";
    input.step = "any";
    if (field.schema.minimum !== undefined) input.min = String(field.schema.minimum);
    if (field.schema.maximum !== undefined) input.max = String(field.schema.maximum);
    box.append(input, el("span", "unit", field.unit || ""));
  } else if (control === "text") {
    box = input = el("input", "text");
    input.type = "text";
    input.spellcheck = false;
    if (field.placeholder) input.placeholder = field.placeholder;
  } else {
    // A list or a fixed set of choices: VS Code's settings editor handles those.
    box = el("button", "link", "Edit in VS Code Settings");
    box.type = "button";
    box.addEventListener("click", () => vscode.postMessage({ type: "openVsSettings", key: field.key }));
  }

  const desc = description(field.schema.markdownDescription || field.schema.description || "");
  const error = el("p", "row-error hidden");
  error.setAttribute("aria-live", "polite");
  const facts = el("span", "facts");
  const override = el("span", "override hidden");
  const overrideText = el("span");
  const overrideOpen = el("button", "link", "Open in VS Code Settings");
  overrideOpen.type = "button";
  overrideOpen.addEventListener("click", () => vscode.postMessage({ type: "openVsSettings", key: field.key }));
  override.append(overrideText, " ", overrideOpen);
  const reset = el("button", "link reset hidden", "Reset to default");
  reset.type = "button";
  const meta = el("div", "row-meta");
  meta.append(facts, override, reset);

  if (input) {
    input.id = id;
    label.htmlFor = id;
    desc.id = id + "-desc";
    error.id = id + "-error";
    input.setAttribute("aria-describedby", desc.id + " " + error.id);
  }
  // A text field gets its own line under the description; the other controls sit next to the name.
  if (control === "text") {
    row.append(head, desc, box, error, meta);
  } else {
    head.append(box);
    row.append(head, desc, error, meta);
  }

  const r = { field, row, input, error, facts, override, overrideText, reset, dirty: false };
  if (input) wire(r);
  reset.addEventListener("click", () => {
    r.dirty = false;
    hideError(r);
    vscode.postMessage({ type: "reset", key: r.field.key });
  });
  rows.set(field.key, r);
  return row;
}

function wire(r) {
  const { input } = r;
  input.addEventListener("change", () => commit(r));
  if (input.type === "checkbox") return;
  input.addEventListener("input", () => {
    r.dirty = true;
    hideError(r);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Undo the typing: back to the saved value.
      r.dirty = false;
      hideError(r);
      setControl(r);
    }
  });
}

/** Sends a completed change, after the same check the extension makes. */
function commit(r) {
  const { field, input } = r;
  const control = controlOf(field.schema);
  const raw =
    control === "switch" ? input.checked : control === "number" ? (input.value.trim() === "" ? NaN : Number(input.value)) : input.value;
  const checked = checkSettingValue(field.schema, raw);
  if (!checked.ok) {
    showError(r, checked.error);
    return;
  }
  r.dirty = false;
  hideError(r);
  if (checked.value === field.value) {
    setControl(r); // "030" or " claude " back to the saved form
    return;
  }
  vscode.postMessage({ type: "set", key: field.key, value: checked.value });
}

/** Shows the saved value in the control. */
function setControl(r) {
  const { field, input } = r;
  if (!input) return;
  if (input.type === "checkbox") input.checked = field.value === true;
  else input.value = field.value === undefined || field.value === null ? "" : String(field.value);
}

function showError(r, text) {
  r.error.textContent = text;
  r.error.classList.remove("hidden");
  r.row.classList.add("invalid");
}

function hideError(r) {
  r.error.classList.add("hidden");
  r.row.classList.remove("invalid");
}

/** The small print under a setting: why it is dimmed, its range and its default. */
function factsText(field, offParent) {
  const items = [];
  if (offParent) items.push(`Only used while “${offParent.label}” is on`);
  const control = controlOf(field.schema);
  if (control === "number" && rangeText(field.schema)) items.push(rangeText(field.schema));
  const fallback = field.schema.default;
  if ((control === "number" || control === "text") && fallback !== undefined && fallback !== "") {
    items.push("default " + formatSettingValue({ schema: field.schema }, fallback));
  }
  return items.join(" · ");
}

/** A setting named in a description: its value, or its quoted name for an on/off setting. */
function refText(key) {
  const r = rows.get(key);
  if (!r) return key;
  return controlOf(r.field.schema) === "switch" ? `“${r.field.label}”` : String(r.field.value);
}

/** Scrolls to a setting, highlights it for a moment and puts the focus on its control. */
function goTo(key) {
  const r = rows.get(key);
  if (!r) return;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  r.row.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  r.row.classList.remove("flash");
  void r.row.offsetWidth; // restart the highlight
  r.row.classList.add("flash");
  if (r.input) r.input.focus({ preventScroll: true });
}

const toastEl = $("toast");
let toastTimer;

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

// ---- rendering -------------------------------------------------------------

function render(sections) {
  const root = $("sections");
  root.textContent = "";
  rows.clear();
  sections.forEach((section, i) => {
    const card = el("section", "section card");
    const title = el("h2", "section-title", section.title);
    title.id = "section-" + i;
    card.setAttribute("aria-labelledby", title.id);
    card.append(title);
    if (section.description) card.append(el("p", "section-sub", section.description));
    for (const field of section.fields) card.append(buildRow(field));
    root.append(card);
  });
}

/** New values from the extension, put into the page without rebuilding it (focus and typing stay). */
function update(sections) {
  for (const section of sections) {
    for (const field of section.fields) {
      const r = rows.get(field.key);
      r.field = field;
      if (!r.dirty) setControl(r);
      r.row.classList.toggle("modified", field.modified);
      r.reset.classList.toggle("hidden", !field.modified);
      r.reset.title = "Default: " + formatSettingValue(field, field.schema.default);
      const overridden = field.workspaceValue !== undefined;
      r.override.classList.toggle("hidden", !overridden);
      if (overridden) {
        r.overrideText.textContent = `This workspace overrides it: ${formatSettingValue(field, field.workspaceValue)}.`;
      }
    }
  }
  // A setting that only matters while another one is on is dimmed while that one is off.
  for (const r of rows.values()) {
    const parent = r.field.dependsOn ? rows.get(r.field.dependsOn) : undefined;
    const off = parent && parent.field.value !== true ? parent.field : undefined;
    r.row.classList.toggle("inactive", Boolean(off));
    r.facts.textContent = factsText(r.field, off);
  }
  for (const ref of document.querySelectorAll(".ref")) {
    ref.textContent = refText(ref.dataset.key);
  }
}

// ---- messages --------------------------------------------------------------

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "state") {
    const keys = msg.sections.map((s) => s.fields.map((f) => f.key).join()).join("|");
    if (keys !== builtFor) {
      builtFor = keys;
      render(msg.sections);
    }
    update(msg.sections);
  } else if (msg.type === "saved") {
    showToast(msg.reset ? "Back to the default" : "Saved");
  } else if (msg.type === "error") {
    const r = rows.get(msg.key);
    if (r) {
      r.dirty = false;
      setControl(r);
      showError(r, msg.message);
    }
  }
});

$("vsSettingsBtn").addEventListener("click", () => vscode.postMessage({ type: "openVsSettings" }));
vscode.postMessage({ type: "ready" });
