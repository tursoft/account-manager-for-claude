// What the settings page shows: the extension's settings in sections, with labels and units, and
// the checks a value from the page passes before it is written. No VS Code API here, so the page
// script and the tests use it too.

/** Prefix of every setting this extension contributes. */
export const SETTINGS_PREFIX = "accountManagerForClaude.";

/** A setting as package.json contributes it (`contributes.configuration.properties`). */
export interface SettingSchema {
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  markdownDescription?: string;
  description?: string;
  enum?: unknown[];
}

/** How the page shows one setting; `key` is without SETTINGS_PREFIX. */
export interface SettingLayout {
  key: string;
  label: string;
  /** Shown after a number field. */
  unit?: string;
  /** Shown in an empty text field. */
  placeholder?: string;
  /** The on/off setting this one only matters with; the row is dimmed while that is off. */
  dependsOn?: string;
}

export interface SectionLayout {
  title: string;
  description: string;
  settings: SettingLayout[];
}

/** The page's sections and rows, in page order. */
export const SETTINGS_LAYOUT: SectionLayout[] = [
  {
    title: "Switching accounts",
    description: "What happens when the active account runs low, and after a switch.",
    settings: [
      { key: "autoSwitch.enabled", label: "Switch automatically" },
      { key: "autoSwitch.thresholdPercent", label: "Start the countdown at", unit: "% used", dependsOn: "autoSwitch.enabled" },
      { key: "autoSwitch.countdownSeconds", label: "Count down for", unit: "seconds", dependsOn: "autoSwitch.enabled" },
      { key: "autoReloadAfterSwitch", label: "Reload the window after a switch" },
    ],
  },
  {
    title: "Usage limits",
    description: "How often the limits of every saved account are checked, and when they count as high.",
    settings: [
      { key: "autoRefresh", label: "Check usage regularly" },
      { key: "pollIntervalSeconds", label: "Check every", unit: "seconds", dependsOn: "autoRefresh" },
      { key: "requestDelaySeconds", label: "Pause between requests", unit: "seconds" },
      { key: "warnThresholdPercent", label: "Warn from", unit: "% used" },
      { key: "notifyOnLimitReset", label: "Notify when a used-up limit resets" },
    ],
  },
  {
    title: "Usage history",
    description: "Readings for the usage analytics page and the availability calendar. They stay on this computer.",
    settings: [
      { key: "usageHistory.enabled", label: "Collect usage history" },
      { key: "usageHistory.intervalSeconds", label: "Read usage every", unit: "seconds", dependsOn: "usageHistory.enabled" },
      { key: "usageHistory.retentionDays", label: "Keep history for", unit: "days" },
    ],
  },
  {
    title: "Say Hi",
    description: "Say Hi sends one short prompt with an account through the Claude Code CLI, as a warmup.",
    settings: [
      { key: "sayHiModel", label: "Model" },
      { key: "sayHiPrompt", label: "Prompt" },
      { key: "sayHiTimeoutSeconds", label: "Give up after", unit: "seconds" },
    ],
  },
  {
    title: "Claude Code",
    description: "Where the extension finds the Claude Code CLI and the login it uses.",
    settings: [
      { key: "claudeCommand", label: "CLI command" },
      { key: "credentialsPath", label: "Credentials file", placeholder: "~/.claude/.credentials.json" },
    ],
  },
];

/** One row of the page: its layout and the contributed schema. */
export interface SettingField extends SettingLayout {
  schema: SettingSchema;
}

export interface SettingsSection {
  title: string;
  description: string;
  fields: SettingField[];
}

/**
 * The page's sections from the contributed settings, in SETTINGS_LAYOUT's order. A setting no
 * section lists goes under "Other", named after its key, so a new setting is never left out.
 */
export function settingsSections(properties: Record<string, SettingSchema>): SettingsSection[] {
  const schemaOf = (key: string) =>
    Object.prototype.hasOwnProperty.call(properties, SETTINGS_PREFIX + key) ? properties[SETTINGS_PREFIX + key] : undefined;
  const placed = new Set<string>();
  const sections: SettingsSection[] = [];
  for (const section of SETTINGS_LAYOUT) {
    const fields: SettingField[] = [];
    for (const layout of section.settings) {
      const schema = schemaOf(layout.key);
      if (schema) {
        fields.push({ ...layout, schema });
        placed.add(layout.key);
      }
    }
    if (fields.length > 0) {
      sections.push({ title: section.title, description: section.description, fields });
    }
  }
  const others = Object.keys(properties)
    .filter((k) => k.startsWith(SETTINGS_PREFIX) && !placed.has(k.slice(SETTINGS_PREFIX.length)))
    .map((k) => {
      const key = k.slice(SETTINGS_PREFIX.length);
      return { key, label: labelOf(key), schema: properties[k] };
    });
  if (others.length > 0) {
    sections.push({ title: "Other", description: "", fields: others });
  }
  return sections;
}

/** A name from a setting's key: "usageHistory.retentionDays" -> "Usage history: retention days". */
function labelOf(key: string): string {
  const text = key
    .split(".")
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase())
    .join(": ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The control the page shows for a setting. Anything else (a list, a fixed set of choices) has
 * none: the page links to VS Code's settings for it instead.
 */
export function controlOf(schema: SettingSchema): "switch" | "number" | "text" | undefined {
  if (schema.type === "boolean") return "switch";
  if (schema.type === "number") return "number";
  if (schema.type === "string" && !schema.enum) return "text";
  return undefined;
}

export type CheckedValue = { ok: true; value: unknown } | { ok: false; error: string };

/** Checks a value from the page against the setting's schema; the extension writes only what passes. */
export function checkSettingValue(schema: SettingSchema, value: unknown): CheckedValue {
  switch (controlOf(schema)) {
    case "switch":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "Choose on or off." };
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: "Enter a number." };
      }
      const { minimum: min, maximum: max } = schema;
      if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
        const range = rangeText(schema);
        return { ok: false, error: min !== undefined && max !== undefined ? `Enter a number from ${range}.` : `Enter ${range}.` };
      }
      return { ok: true, value };
    }
    case "text":
      return typeof value === "string" ? { ok: true, value: value.trim() } : { ok: false, error: "Enter text." };
    default:
      return { ok: false, error: "This setting can only be changed in VS Code's settings." };
  }
}

/**
 * What to write to the user settings for a checked value: nothing (undefined removes it) for the
 * default or for empty text, so settings.json keeps only real changes.
 */
export function storedValue(schema: SettingSchema, value: unknown): unknown {
  return value === schema.default || value === "" ? undefined : value;
}

/** The allowed range of a number setting in words: "1 to 100", "60 or more", "60 or less". */
export function rangeText(schema: SettingSchema): string {
  const { minimum: min, maximum: max } = schema;
  if (min !== undefined && max !== undefined) return `${min} to ${max}`;
  if (min !== undefined) return `${min} or more`;
  if (max !== undefined) return `${max} or less`;
  return "";
}

/** A setting's value in words: "on", "30 seconds", "95% used", "“haiku”". */
export function formatSettingValue(field: { schema: SettingSchema; unit?: string }, value: unknown): string {
  if (field.schema.type === "boolean") return value ? "on" : "off";
  if (typeof value === "string") return value === "" ? "empty" : `“${value}”`;
  const unit = field.unit ?? "";
  if (unit === "") return String(value);
  return unit.startsWith("%") ? `${value}${unit}` : `${value} ${unit}`;
}

export type DescriptionPart =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "setting"; key: string };

/**
 * Splits a setting's markdownDescription into plain text, `code`, **bold** and references to other
 * settings (`#accountManagerForClaude.key#`), so the page builds it from text nodes, without HTML.
 */
export function descriptionParts(markdown: string): DescriptionPart[] {
  const parts: DescriptionPart[] = [];
  const markup = /`#([^`#]+)#`|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = markup.exec(markdown); m; m = markup.exec(markdown)) {
    if (m.index > last) {
      parts.push({ kind: "text", text: markdown.slice(last, m.index) });
    }
    const [, ref, code, bold] = m;
    if (ref !== undefined) {
      parts.push(
        ref.startsWith(SETTINGS_PREFIX) ? { kind: "setting", key: ref.slice(SETTINGS_PREFIX.length) } : { kind: "code", text: ref }
      );
    } else if (code !== undefined) {
      parts.push({ kind: "code", text: code });
    } else {
      parts.push({ kind: "bold", text: bold });
    }
    last = m.index + m[0].length;
  }
  if (last < markdown.length) {
    parts.push({ kind: "text", text: markdown.slice(last) });
  }
  return parts;
}
