import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";

/**
 * Text secrets stored by service name — where Claude Code keeps its login on macOS.
 */
export interface SecretStore {
  /** The stored text, null when there is no such item, undefined when the store could not be read. */
  read(service: string): Promise<string | null | undefined>;
  /** Creates or replaces the item. Resolves false when the store refused the write. */
  write(service: string, value: string): Promise<boolean>;
  /** Removes the item. Resolves true when it is gone (or never existed). */
  delete(service: string): Promise<boolean>;
  /** A file whose modification time changes whenever the store is written, if there is one. */
  readonly changeMarker?: string;
}

const SECURITY = "/usr/bin/security";
const TIMEOUT_MS = 5_000;
/** errSecItemNotFound, as `security` reports it. */
const ITEM_NOT_FOUND = 44;
/** Claude Code passes a write through `security -i` (off the command line) up to this length. */
const MAX_STDIN_COMMAND = 4032;

/**
 * The macOS login keychain, accessed through `/usr/bin/security` exactly like Claude
 * Code does. Items Claude Code creates this way trust the `security` tool, so reading
 * and updating them never shows a keychain prompt.
 */
export class MacKeychain implements SecretStore {
  readonly changeMarker = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");

  constructor(private readonly account: string = keychainAccount()) {}

  async read(service: string): Promise<string | null | undefined> {
    const res = await runSecurity(["find-generic-password", "-a", this.account, "-w", "-s", service]);
    if (res.code === 0) {
      return res.stdout.replace(/\r?\n$/, "");
    }
    return res.code === ITEM_NOT_FOUND ? null : undefined;
  }

  async write(service: string, value: string): Promise<boolean> {
    const hex = Buffer.from(value, "utf8").toString("hex");
    const command = `add-generic-password -U -a "${this.account}" -s "${service}" -X "${hex}"\n`;
    const res =
      command.length <= MAX_STDIN_COMMAND && !service.includes('"')
        ? await runSecurity(["-i"], command)
        : await runSecurity(["add-generic-password", "-U", "-a", this.account, "-s", service, "-X", hex]);
    return res.code === 0;
  }

  async delete(service: string): Promise<boolean> {
    const res = await runSecurity(["delete-generic-password", "-a", this.account, "-s", service]);
    return res.code === 0 || res.code === ITEM_NOT_FOUND;
  }
}

/** The keychain account name Claude Code files its items under. */
export function keychainAccount(): string {
  let user: string;
  try {
    user = process.env.USER || os.userInfo().username;
  } catch {
    user = "";
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user";
}

/**
 * Parses a JSON item read through `security -w`, which prints the data hex-encoded
 * instead of as text when it contains any non-ASCII byte.
 */
export function parseKeychainJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* maybe hex-encoded */
  }
  const trimmed = text.trim();
  if (trimmed.length > 0 && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    try {
      return JSON.parse(Buffer.from(trimmed, "hex").toString("utf8"));
    } catch {
      /* not JSON either */
    }
  }
  return undefined;
}

function runSecurity(
  args: string[],
  input?: string
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout });
      }
    };
    const child = spawn(SECURITY, args, { stdio: ["pipe", "pipe", "ignore"] });
    // A locked keychain can wait for a password dialog; never hang on it.
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {
      /* reported through the exit code */
    });
    child.stdin?.end(input);
  });
}
