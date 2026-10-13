import {
  configure,
  TextReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";
import { AccountProfile, OAuthCreds } from "./types";

/**
 * Password-protected backups of the account list. The archive is a standard ZIP
 * with a single AES-256 encrypted entry (`accounts.json`) holding the profile
 * metadata and each profile's OAuth tokens, so it can also be opened with 7-Zip
 * or similar tools given the password.
 */

const FORMAT = "tursoft-claude-switcher-backup";
const FORMAT_VERSION = 1;
const ENTRY_NAME = "accounts.json";
export const MIN_BACKUP_PASSWORD_LENGTH = 8;

// The extension host has no Web Workers; run compression inline.
configure({ useWebWorkers: false });

export interface BackupEntry {
  profile: AccountProfile;
  creds: OAuthCreds | null;
}

/** Preferences carried in a backup besides the accounts. */
export interface BackupSettings {
  /** Panel choices: sort order and filters. */
  view?: Record<string, unknown>;
  /** User-level `accountManagerForClaude.*` settings, keyed without the prefix. */
  config?: Record<string, unknown>;
}

export interface BackupContents {
  accounts: BackupEntry[];
  settings?: BackupSettings;
}

interface BackupFile {
  format: typeof FORMAT;
  version: number;
  createdAt: string;
  extensionVersion?: string;
  accounts: BackupEntry[];
  settings?: BackupSettings;
}

export class BackupError extends Error {}

export async function createBackupZip(
  entries: BackupEntry[],
  password: string,
  extensionVersion?: string,
  settings?: BackupSettings
): Promise<Uint8Array> {
  const file: BackupFile = {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    extensionVersion,
    // Usage snapshots are stale by the time a backup is restored; leave them out.
    accounts: entries.map(({ profile, creds }) => {
      const { lastUsage: _lastUsage, ...rest } = profile;
      return { profile: rest as AccountProfile, creds };
    }),
    settings,
  };
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    password,
    encryptionStrength: 3, // AES-256
  });
  await writer.add(ENTRY_NAME, new TextReader(JSON.stringify(file, null, 2)));
  return writer.close();
}

export async function readBackupZip(data: Uint8Array, password: string): Promise<BackupContents> {
  let text: string;
  const reader = new ZipReader(new Uint8ArrayReader(data));
  try {
    let entries;
    try {
      entries = await reader.getEntries();
    } catch {
      throw new BackupError("The file is not a valid ZIP archive.");
    }
    const entry = entries.find((e) => e.filename === ENTRY_NAME);
    if (!entry || entry.directory) {
      throw new BackupError(`The archive does not contain ${ENTRY_NAME}; it is not an account backup.`);
    }
    try {
      text = await entry.getData(new TextWriter(), { password });
    } catch (e) {
      const message = (e as Error).message ?? "";
      throw new BackupError(
        /password/i.test(message) ? "Wrong password." : `Could not decrypt the backup: ${message}`
      );
    }
  } finally {
    await reader.close();
  }

  let parsed: Partial<BackupFile>;
  try {
    parsed = JSON.parse(text) as Partial<BackupFile>;
  } catch {
    throw new BackupError("The backup content is corrupted.");
  }
  if (parsed.format !== FORMAT || !Array.isArray(parsed.accounts)) {
    throw new BackupError("The file is not an Account Manager for Claude backup.");
  }
  if (typeof parsed.version !== "number" || parsed.version > FORMAT_VERSION) {
    throw new BackupError("The backup was made by a newer version of the extension; update it first.");
  }
  const accounts = parsed.accounts.filter(
    (a): a is BackupEntry =>
      Boolean(a && a.profile && typeof a.profile.id === "string" && typeof a.profile.label === "string")
  );
  const settings = isRecord(parsed.settings)
    ? {
        view: isRecord(parsed.settings.view) ? parsed.settings.view : undefined,
        config: isRecord(parsed.settings.config) ? parsed.settings.config : undefined,
      }
    : undefined;
  return { accounts, settings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
