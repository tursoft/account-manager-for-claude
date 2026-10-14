import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { sameDir, withClaudeStorageLock } from "./claudeLock";
import {
  hasAccessToken,
  hasUsableOAuthCreds,
  sameNonEmptyToken,
} from "./credentialValidation";
import { MacKeychain, parseKeychainJson, SecretStore } from "./keychain";
import { CredentialsFile, OAuthCreds } from "./types";

export interface WriteCredsOptions {
  /**
   * Organization of the login being written. A string replaces the file's
   * `organizationUuid`, null removes a value left behind by another account, and
   * undefined keeps it (a token rotation of the same login).
   */
  organizationUuid?: string | null;
}

export interface CredentialsManagerOptions {
  /**
   * Where Claude Code keeps its login instead of `.credentials.json`: the login
   * keychain on macOS (the default there), none elsewhere. null forces the file.
   */
  keychain?: SecretStore | null;
}

/** Keychain service of the default config dir; other dirs add a hash of their path. */
export const KEYCHAIN_SERVICE = "Claude Code-credentials";
const STORAGE_LOCK_TIMEOUT_MS = 10_000;

/**
 * Reads and writes Claude Code's stored login: the `Claude Code-credentials` keychain
 * item on macOS, `~/.claude/.credentials.json` elsewhere (and on macOS when the
 * keychain holds nothing). Switching accounts = swapping its `claudeAiOauth` tokens.
 */
export class CredentialsManager {
  private readonly keychain: SecretStore | null;

  constructor(options: CredentialsManagerOptions = {}) {
    this.keychain =
      options.keychain !== undefined
        ? options.keychain
        : process.platform === "darwin"
          ? new MacKeychain()
          : null;
  }

  getCredentialsPath(configDir?: string): string {
    if (configDir) {
      return path.join(configDir, ".credentials.json");
    }

    const override = vscode.workspace
      .getConfiguration("accountManagerForClaude")
      .get<string>("credentialsPath", "")
      .trim();
    if (override) {
      return override;
    }
    return path.join(os.homedir(), ".claude", ".credentials.json");
  }

  getConfigDir(): string {
    return path.dirname(this.getCredentialsPath());
  }

  /** The config directory plain Claude Code sessions (terminals, regular windows) use. */
  getGlobalConfigDir(): string {
    const env = process.env.CLAUDE_CONFIG_DIR?.trim();
    return env ? env : path.join(os.homedir(), ".claude");
  }

  /**
   * Claude Code keeps account metadata (`oauthAccount`) in `~/.claude.json` for the
   * default config dir and in `<dir>/.claude.json` when CLAUDE_CONFIG_DIR is set.
   */
  getGlobalConfigFile(configDir: string = this.getConfigDir()): string {
    return isDefaultConfigDir(configDir)
      ? path.join(os.homedir(), ".claude.json")
      : path.join(configDir, ".claude.json");
  }

  /** Keychain item Claude Code keeps the login of `configDir` in (macOS). */
  getKeychainService(configDir?: string): string {
    return keychainServiceFor(path.dirname(this.getCredentialsPath(configDir)));
  }

  /** Files whose changes signal a new login or token rotation in `configDir`. */
  getWatchPaths(configDir?: string): string[] {
    const paths = [this.getCredentialsPath(configDir)];
    if (this.keychain?.changeMarker) {
      paths.push(this.keychain.changeMarker);
    }
    return paths;
  }

  readOAuthAccount(configDir?: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.getGlobalConfigFile(configDir), "utf8")
      ) as { oauthAccount?: unknown };
      const account = parsed.oauthAccount;
      return account && typeof account === "object" && !Array.isArray(account)
        ? (account as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Replaces only the `oauthAccount` key of Claude Code's global config, so the
   * cached account details (email, organization) match the tokens just written.
   * Leaves the file untouched when it cannot be parsed.
   */
  writeOAuthAccount(account: Record<string, unknown>, configDir?: string): boolean {
    const file = this.getGlobalConfigFile(configDir);
    try {
      let config: Record<string, unknown> = {};
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return false;
        }
        config = parsed as Record<string, unknown>;
      }
      config.oauthAccount = account;
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns the stored claudeAiOauth object, or null if missing/invalid. */
  async readCurrent(configDir?: string): Promise<OAuthCreds | null> {
    const oauth = (await this.readStored(configDir)).doc?.claudeAiOauth;
    return hasAccessToken(oauth) ? (oauth as OAuthCreds) : null;
  }

  /**
   * Stores creds where Claude Code reads them, preserving any other fields that were
   * already present (such as MCP server tokens).
   */
  async writeCreds(
    creds: OAuthCreds,
    configDir?: string,
    options: WriteCredsOptions = {}
  ): Promise<void> {
    if (!hasUsableOAuthCreds(creds)) {
      throw new Error("Refusing to write incomplete Claude OAuth credentials.");
    }
    await this.mutate(configDir, (existing) => {
      const next: CredentialsFile = { ...(existing ?? {}), claudeAiOauth: creds };
      if (options.organizationUuid === null) {
        delete next.organizationUuid;
      } else if (options.organizationUuid !== undefined) {
        next.organizationUuid = options.organizationUuid;
      }
      return next;
    });
  }

  /**
   * Replaces a rotating-token login only while it still contains the refresh token
   * that was just spent. If Claude Code won the race and already wrote a newer
   * generation, that newer login is left untouched.
   */
  async writeCredsIfCurrent(
    expected: OAuthCreds,
    next: OAuthCreds,
    configDir?: string
  ): Promise<boolean> {
    if (!hasUsableOAuthCreds(next)) {
      throw new Error("Refusing to write incomplete Claude OAuth credentials.");
    }
    return this.mutate(configDir, (existing) => {
      const current = existing?.claudeAiOauth;
      if (!current || !hasAccessToken(current) || !sameNonEmptyToken(current.refreshToken, expected.refreshToken)) {
        return undefined;
      }
      return { ...existing!, claudeAiOauth: next };
    });
  }

  private backupPath(): string {
    return this.getCredentialsPath() + ".bak";
  }

  private backupService(service: string): string {
    return `${service} (Account Manager backup)`;
  }

  /** Tokens saved by the last switch (used to undo it). */
  async readBackup(): Promise<OAuthCreds | null> {
    const oauth = (await this.readBackupDocument())?.claudeAiOauth;
    return hasAccessToken(oauth) ? (oauth as OAuthCreds) : null;
  }

  /** Saves the current login next to it (enables undoing a switch). */
  async backupCurrent(): Promise<boolean> {
    const stored = await this.readStored();
    if (stored.source === "keychain" && stored.doc && this.keychain) {
      const service = this.backupService(this.getKeychainService());
      if (await this.keychain.write(service, JSON.stringify(stored.doc))) {
        removeFile(this.backupPath());
        return true;
      }
      return false;
    }
    const p = this.getCredentialsPath();
    try {
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, this.backupPath());
        // Only one backup: an older one in the keychain must not win over this one.
        await this.keychain?.delete(this.backupService(this.getKeychainService()));
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  async hasBackup(): Promise<boolean> {
    return (await this.readBackupDocument()) !== null;
  }

  /** Restores the login saved by backupCurrent. Returns true on success. */
  async restoreBackup(): Promise<boolean> {
    const backup = await this.readBackupDocument();
    if (!backup) {
      return false;
    }
    try {
      await this.mutate(undefined, () => backup);
      return true;
    } catch {
      return false;
    }
  }

  /** Moves an existing login out of the way before a forced repair login. */
  async moveCredentialsAside(configDir?: string, reason = "backup"): Promise<string | null> {
    let moved: string | null = null;
    if (this.keychain) {
      const service = this.getKeychainService(configDir);
      const text = await this.keychain.read(service);
      if (typeof text === "string") {
        const doc = toCredentialsFile(parseKeychainJson(text));
        const target = this.backupService(service);
        if (doc && !(await this.keychain.write(target, JSON.stringify(doc)))) {
          throw new Error("Failed to move existing credentials aside: the macOS Keychain refused the backup.");
        }
        if (!(await this.keychain.delete(service))) {
          throw new Error("Failed to move existing credentials aside: the macOS Keychain item could not be removed.");
        }
        moved = target;
      }
    }

    const p = this.getCredentialsPath(configDir);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (!fs.existsSync(p)) {
        return moved;
      }
      const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
      const target = `${p}.${reason}-${stamp}`;
      fs.renameSync(p, target);
      return target;
    } catch (e) {
      throw new Error("Failed to move existing credentials aside: " + (e as Error).message);
    }
  }

  /**
   * Forgets the keychain items of an isolated config dir that is being deleted (the
   * directory itself only holds the file copy).
   */
  async discard(configDir: string): Promise<void> {
    if (this.keychain) {
      const service = this.getKeychainService(configDir);
      await this.keychain.delete(service);
      await this.keychain.delete(this.backupService(service));
    }
  }

  /**
   * The login document Claude Code would read: the keychain item when it exists
   * (macOS), otherwise the plaintext file Claude Code falls back to.
   */
  private async readStored(configDir?: string): Promise<{
    doc: CredentialsFile | null;
    source: "keychain" | "file" | "none";
    /** The keychain could not be read, so it may hold a login nobody sees. */
    keychainUnreadable?: boolean;
  }> {
    let keychainUnreadable = false;
    if (this.keychain) {
      const text = await this.keychain.read(this.getKeychainService(configDir));
      const doc = typeof text === "string" ? toCredentialsFile(parseKeychainJson(text)) : null;
      if (doc) {
        return { doc, source: "keychain" };
      }
      keychainUnreadable = text === undefined;
    }
    const doc = readJsonFile(this.getCredentialsPath(configDir));
    return { doc, source: doc ? "file" : "none", keychainUnreadable };
  }

  private async readBackupDocument(): Promise<CredentialsFile | null> {
    if (this.keychain) {
      const text = await this.keychain.read(this.backupService(this.getKeychainService()));
      const doc = typeof text === "string" ? toCredentialsFile(parseKeychainJson(text)) : null;
      if (doc) {
        return doc;
      }
    }
    return readJsonFile(this.backupPath());
  }

  /**
   * Read-modify-write of the stored login under Claude Code's storage lock. `change`
   * returns the new document, or undefined to leave it as it is.
   */
  private async mutate(
    configDir: string | undefined,
    change: (existing: CredentialsFile | null) => CredentialsFile | undefined
  ): Promise<boolean> {
    const p = this.getCredentialsPath(configDir);
    const locked = await withClaudeStorageLock(path.dirname(p), STORAGE_LOCK_TIMEOUT_MS, async () => {
      const stored = await this.readStored(configDir);
      if (stored.keychainUnreadable) {
        // Writing now could replace a login (and Claude Code's MCP tokens) it holds.
        throw new Error(
          "Could not read Claude Code's login from the macOS Keychain. Unlock the login keychain and try again."
        );
      }
      const next = change(stored.doc);
      if (!next) {
        return false;
      }

      if (this.keychain) {
        if (await this.keychain.write(this.getKeychainService(configDir), JSON.stringify(next))) {
          // Like Claude Code: once the keychain holds the login, the plaintext copy goes.
          if (stored.source !== "keychain") {
            removeFile(p);
          }
          return true;
        }
        if (stored.source === "keychain") {
          // Claude Code keeps reading the keychain item; a file write would be ignored.
          throw new Error(
            "Could not update Claude Code's login in the macOS Keychain. Unlock the login keychain and try again."
          );
        }
      }

      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, p);
      try {
        fs.chmodSync(p, 0o600);
      } catch {
        /* best-effort on Windows */
      }
      return true;
    });
    if (!locked.acquired) {
      throw new Error("Claude Code is saving its login right now. Try again in a few seconds.");
    }
    return locked.value ?? false;
  }
}

/** True when Claude Code uses `configDir` without being told to (no CLAUDE_CONFIG_DIR). */
export function isDefaultConfigDir(configDir: string): boolean {
  return !process.env.CLAUDE_CONFIG_DIR?.trim() && sameDir(configDir, path.join(os.homedir(), ".claude"));
}

/**
 * The keychain service Claude Code uses for a config dir: `Claude Code-credentials`
 * for the default one, plus `-<first 8 hex of sha256(dir)>` when CLAUDE_CONFIG_DIR
 * points elsewhere. The hash is over the exact CLAUDE_CONFIG_DIR string.
 */
export function keychainServiceFor(configDir: string): string {
  if (isDefaultConfigDir(configDir)) {
    return KEYCHAIN_SERVICE;
  }
  const env = process.env.CLAUDE_CONFIG_DIR;
  const dir = env?.trim() && sameDir(configDir, env) ? env : configDir;
  const hash = crypto.createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

/**
 * Environment overrides that make a spawned Claude Code use `configDir`. The default
 * dir gets none: naming it in CLAUDE_CONFIG_DIR would switch Claude Code to another
 * keychain item and to `<dir>/.claude.json`.
 */
export function claudeConfigEnv(configDir: string): NodeJS.ProcessEnv {
  if (isDefaultConfigDir(configDir)) {
    return {};
  }
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env?.trim() && sameDir(configDir, env) ? {} : { CLAUDE_CONFIG_DIR: configDir };
}

function toCredentialsFile(value: unknown): CredentialsFile | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CredentialsFile)
    : null;
}

function readJsonFile(file: string): CredentialsFile | null {
  try {
    return toCredentialsFile(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best-effort */
  }
}
