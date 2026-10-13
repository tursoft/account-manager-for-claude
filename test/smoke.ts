import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseUsage, UsagePoller } from "../src/usage";
import { CredentialsManager } from "../src/credentials";
import { requiresProfileReauthorization, TokenRefresher } from "../src/oauth";
import { AccountStore } from "../src/accountStore";
import { createBackupZip, readBackupZip } from "../src/backup";
import { buildBrowserAuthorizationUrl, parseBrowserTokenResponse } from "../src/browserOAuth";
import { claudeLockPaths, withClaudeConfigLocks } from "../src/claudeLock";
import { CredentialSync } from "../src/credentialSync";
import { sameIdentity } from "../src/identity";
import { ProfileActivityRegistry } from "../src/profileActivity";
import { SwitchService } from "../src/switchService";
import { findResetWindows } from "../src/limitNotifier";
import { HISTORY_HEARTBEAT_MS, HistoryPoint, UsageHistory } from "../src/usageHistory";
import { bucketSeries, bucketSizeFor, kindsIn, seriesTotal } from "../src/historySeries";
import {
  coveredSpans,
  cycleMs,
  usedBetween,
  usedCapacityIn,
  utilizationIn,
  utilizationSeries,
  utilizationSummary,
  periodSlices,
  utilizationByPeriod,
} from "../src/utilization";
import { buildTimeline, Segment, timelineStats } from "../src/availability";
import { AVATAR_COLORS, avatarDescription, avatarState, starburstGlyph } from "../src/avatar";
import { nameTone, nameToneDescription, resetTone, toneOfPercent } from "../src/tone";
import { noProposalReason, propose, rankAccounts, urgencyOf } from "../src/propose";
import {
  DEFAULT_LISTING,
  extraFilterLabels,
  filtersActive,
  ListAccount,
  matchesListing,
  normalizeListing,
  scopesOf,
  SORTS,
  sortAccounts,
  SortKey,
} from "../src/listing";
import { ClaudeAuthIdentity, OAuthCreds, UsageSnapshot } from "../src/types";
import { anthropicQueue, RequestQueue } from "../src/requestQueue";

// Requests to Anthropic are spaced out in real use; the tests don't need the pause.
anthropicQueue.setGap(0);

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? "  PASS" : "  FAIL") + " - " + name);
  if (!cond) failures++;
}

console.log("parseUsage:");
// Real captured /api/oauth/usage response shape
const real = {
  five_hour: { utilization: 12.0, resets_at: "2026-06-25T11:00:00+00:00" },
  seven_day: { utilization: 8.0, resets_at: "2026-06-29T12:00:00+00:00" },
  limits: [
    { kind: "session", group: "session", percent: 12, severity: "normal", resets_at: "2026-06-25T11:00:00+00:00", is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 8, severity: "normal", resets_at: "2026-06-29T12:00:00+00:00", is_active: false },
  ],
};
const snap = parseUsage(real as never);
check("2 windows from limits[]", snap.windows.length === 2);
check("sessionPercent = 12", snap.sessionPercent === 12);
check("weeklyPercent = 8", snap.weeklyPercent === 8);
check("session label", snap.windows[0].label === "Session (5h)");

const fb = parseUsage({ five_hour: { utilization: 50, resets_at: null }, seven_day: { utilization: 90, resets_at: null } } as never);
check("fallback sessionPercent = 50", fb.sessionPercent === 50);
check("fallback weeklyPercent = 90", fb.weeklyPercent === 90);

const em = parseUsage({} as never);
check("empty -> 0 windows, null percents", em.windows.length === 0 && em.sessionPercent === null);

console.log("CredentialsManager (temp file):");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-test-"));
const credPath = path.join(tmpDir, ".credentials.json");
process.env.TEST_CRED_PATH = credPath;
const mgr = new CredentialsManager();

const credsA = { accessToken: "AAA", refreshToken: "ra", expiresAt: 111, scopes: ["x"], subscriptionType: "pro" };
const credsB = { accessToken: "BBB", refreshToken: "rb", expiresAt: 222, scopes: ["y"], subscriptionType: "max" };

check("path resolves to override", mgr.getCredentialsPath() === credPath);
mgr.writeCreds(credsA as never);
check("write + read account A", mgr.readCurrent()?.accessToken === "AAA");

mgr.backupCurrent();
check("hasBackup after backup", mgr.hasBackup() === true);

mgr.writeCreds(credsB as never);
check("switch to account B", mgr.readCurrent()?.accessToken === "BBB");

mgr.restoreBackup();
check("undo restores account A", mgr.readCurrent()?.accessToken === "AAA");

fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: credsA, otherField: 123 }));
mgr.writeCreds(credsB as never);
const rawAfter = JSON.parse(fs.readFileSync(credPath, "utf8"));
check("preserves extra fields on write", rawAfter.otherField === 123 && rawAfter.claudeAiOauth.accessToken === "BBB");

check(
  "does not overwrite a credential file that Claude already rotated",
  mgr.writeCredsIfCurrent(credsA as never, credsB as never) === false &&
    mgr.readCurrent()?.refreshToken === "rb"
);
check(
  "compare-and-swap persists a rotation from the current generation",
  mgr.writeCredsIfCurrent(credsB as never, credsA as never) === true &&
    mgr.readCurrent()?.refreshToken === "ra"
);

fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] } }));
check("empty tokens are not a current login", mgr.readCurrent() === null);

mgr.writeCreds(credsA as never);
let refusedIncompleteWrite = false;
try {
  mgr.writeCreds({ accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] } as never);
} catch {
  refusedIncompleteWrite = true;
}
check("refuses to write incomplete credentials", refusedIncompleteWrite);
check("incomplete write does not overwrite existing credentials", mgr.readCurrent()?.accessToken === "AAA");

fs.rmSync(tmpDir, { recursive: true, force: true });

function createStore(): AccountStore {
  const globalState = new Map<string, unknown>();
  const workspaceState = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const memento = (values: Map<string, unknown>) => ({
    get: <T>(key: string, defaultValue?: T): T => (values.has(key) ? values.get(key) : defaultValue) as T,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  });

  return new AccountStore({
    globalState: memento(globalState),
    workspaceState: memento(workspaceState),
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
  } as never);
}

function runBrowserOAuthTests(): void {
  console.log("Browser OAuth:");
  const url = new URL(buildBrowserAuthorizationUrl(43123, "expected-state", "pkce-challenge"));
  check(
    "uses the Claude subscription authorization endpoint",
    url.origin === "https://claude.com" && url.pathname === "/cai/oauth/authorize"
  );
  check(
    "uses loopback callback and PKCE",
    url.searchParams.get("redirect_uri") === "http://127.0.0.1:43123/callback" &&
      url.searchParams.get("code_challenge") === "pkce-challenge" &&
      url.searchParams.get("code_challenge_method") === "S256"
  );
  check(
    "binds the authorization response to a random state",
    url.searchParams.get("state") === "expected-state"
  );

  const parsed = parseBrowserTokenResponse({
    access_token: "browser-access",
    refresh_token: "browser-refresh",
    expires_in: 3600,
    refresh_token_expires_in: 7200,
    scope: "user:profile user:inference",
    account: { email_address: "browser@example.com" },
    organization: { uuid: "org-browser", name: "Browser Org" },
  });
  check(
    "maps a browser token response to credentials",
    parsed.creds?.accessToken === "browser-access" &&
      parsed.creds.refreshToken === "browser-refresh" &&
      parsed.creds.scopes.join(" ") === "user:profile user:inference"
  );
  check(
    "maps account identity without the CLI",
    parsed.identity?.email === "browser@example.com" && parsed.identity.orgId === "org-browser"
  );
}

function runProfileActivityTests(): void {
  console.log("ProfileActivityRegistry:");
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-activity-test-"));
  const context = { globalStorageUri: { fsPath: storageDir } } as never;
  const owner = new ProfileActivityRegistry(context);
  const observer = new ProfileActivityRegistry(context);
  owner.setActiveProfile("profile-a");
  check("shares active-profile ownership across extension hosts", observer.isActive("profile-a"));
  owner.dispose();
  check("removes the window lease on disposal", !observer.isActive("profile-a"));
  observer.dispose();
  fs.rmSync(storageDir, { recursive: true, force: true });
}

async function runAccountStoreTests(): Promise<void> {
  console.log("AccountStore:");

  const store = createStore();
  const profile = await store.addFromCreds("Broken", {
    accessToken: "stored-access",
    refreshToken: "",
    expiresAt: 111,
    scopes: [],
  });

  const noRefreshStore = createStore();
  await noRefreshStore.addFromCreds("A", {
    accessToken: "a",
    refreshToken: "",
    expiresAt: 111,
    scopes: [],
  });
  const matched = await noRefreshStore.findByTokens({
    accessToken: "b",
    refreshToken: "",
    expiresAt: 222,
    scopes: [],
  });
  check("does not match accounts by empty refresh token", matched === undefined);

  await store.updateUsage(profile.id, {
    fetchedAt: 333,
    windows: [],
    sessionPercent: null,
    weeklyPercent: null,
    error: "Failed to refresh token: HTTP 400 invalid_grant",
    retryAfter: 444,
  });
  await store.clearUsageError(profile.id);
  const clearedUsage = store.get(profile.id)?.lastUsage;
  check("clearUsageError removes auth error", clearedUsage?.error === undefined);
  check("clearUsageError removes retry backoff", clearedUsage?.retryAfter === undefined);
  check("clearUsageError preserves usage timestamp", clearedUsage?.fetchedAt === 333);

  await store.updateUsage(profile.id, {
    fetchedAt: 555,
    windows: [],
    sessionPercent: null,
    weeklyPercent: null,
    error: "Failed to refresh token: HTTP 400 invalid_grant",
    retryAfter: 666,
  });
  await store.markRefreshTokenDead(profile.id, "stored-refresh");
  await store.updateCreds(profile.id, {
    accessToken: "reauth-access",
    refreshToken: "reauth-refresh",
    expiresAt: 777,
    scopes: ["user:profile"],
  });
  const reauthed = store.get(profile.id);
  check("new credentials clear auth error", reauthed?.lastUsage?.error === undefined);
  check("new credentials clear retry backoff", reauthed?.lastUsage?.retryAfter === undefined);
  check("new credentials clear the dead-token marker", reauthed?.deadRefreshTokenHash === undefined);

  await store.updateIdentity(profile.id, { email: "owner@example.com", orgId: "org-1" });
  await store.updateIdentity(profile.id, { accountUuid: "acct-1" });
  check(
    "identity updates merge instead of dropping known fields",
    store.get(profile.id)?.authEmail === "owner@example.com" &&
      store.get(profile.id)?.authAccountUuid === "acct-1"
  );
}

function runIdentityTests(): void {
  console.log("Identity:");
  check(
    "same account uuid matches",
    sameIdentity({ accountUuid: "a", orgId: "o" }, { accountUuid: "a", email: "x@y" })
  );
  check(
    "two people in one Team organization are different accounts",
    !sameIdentity({ email: "anna@team.com", orgId: "team" }, { email: "bob@team.com", orgId: "team" })
  );
  check(
    "one person in two organizations are different subscriptions",
    !sameIdentity({ email: "me@x.com", orgId: "personal" }, { email: "me@x.com", orgId: "team" })
  );
  check("email comparison ignores case", sameIdentity({ email: "Me@X.com" }, { email: "me@x.com" }));
  check(
    "legacy org-only identities still match",
    sameIdentity({ orgId: "o" }, { orgId: "o" })
  );
}

async function runClaudeLockTests(): Promise<void> {
  console.log("Claude Code compatible lock:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-lock-test-"));
  const configDir = path.join(dir, "config");
  const [primary, legacy] = claudeLockPaths(configDir);

  let sawLocks = false;
  const result = await withClaudeConfigLocks([configDir], 1_000, async () => {
    sawLocks = fs.statSync(primary).isDirectory() && fs.existsSync(legacy);
    return 42;
  });
  check("uses Claude Code's .oauth_refresh.lock and legacy <dir>.lock", sawLocks);
  check("returns the action value", result.acquired && result.value === 42);
  check("releases both locks", !fs.existsSync(primary) && !fs.existsSync(legacy));

  fs.mkdirSync(primary);
  const busy = await withClaudeConfigLocks([configDir], 400, async () => 1);
  check("waits for a lock held by Claude Code", !busy.acquired);
  check("does not leave a partial lock behind", !fs.existsSync(legacy));

  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(primary, old, old);
  const stale = await withClaudeConfigLocks([configDir], 400, async () => 2);
  check("takes over a stale lock like proper-lockfile", stale.acquired && stale.value === 2);

  fs.rmSync(dir, { recursive: true, force: true });
}

interface SyncFixture {
  root: string;
  globalDir: string;
  store: AccountStore;
  manager: CredentialsManager;
  sync: CredentialSync;
  homeDir: (id: string) => string;
}

function createSyncFixture(identities: Record<string, ClaudeAuthIdentity> = {}): SyncFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cas-sync-test-"));
  const globalDir = path.join(root, "global");
  fs.mkdirSync(globalDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = globalDir;
  process.env.TEST_CRED_PATH = path.join(globalDir, ".credentials.json");
  const store = createStore();
  const manager = new CredentialsManager();
  const homeDir = (id: string) => path.join(root, "homes", id);
  const sync = new CredentialSync(store, manager, new TokenRefresher(), homeDir, async (creds) =>
    identities[creds.accessToken]
  );
  return { root, globalDir, store, manager, sync, homeDir };
}

function creds(name: string, expiresInMs: number, extra: Partial<OAuthCreds> = {}): OAuthCreds {
  return {
    accessToken: `${name}-access`,
    refreshToken: `${name}-refresh`,
    expiresAt: Date.now() + expiresInMs,
    scopes: ["user:profile", "user:inference"],
    ...extra,
  };
}

async function runCredentialSyncTests(): Promise<void> {
  console.log("CredentialSync:");
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  let tokenResponse: () => Response = () => new Response("{}", { status: 500 });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/oauth/token")) {
      tokenCalls++;
      return tokenResponse();
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    // 1. Claude Code rotated both tokens of the active login while we were not looking.
    {
      const f = createSyncFixture({
        "gen2-access": { accountUuid: "acct-a", email: "a@example.com" },
      });
      const a = await f.store.addFromCreds("A", creds("gen1", 3_600_000), {
        identity: { accountUuid: "acct-a", email: "a@example.com" },
      });
      f.manager.writeCreds(creds("gen2", 7_200_000));
      const state = await f.sync.syncCurrent();
      check("identifies a fully rotated active file by account", state.ownerId === a.id);
      check(
        "imports the rotated generation into the saved profile",
        (await f.store.getCreds(a.id))?.refreshToken === "gen2-refresh"
      );
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 2. A verified login of another, unsaved account is not imported into a profile.
    {
      const f = createSyncFixture({
        "other-access": { accountUuid: "acct-other", email: "other@example.com" },
      });
      const a = await f.store.addFromCreds("A", creds("a1", 3_600_000), {
        identity: { accountUuid: "acct-a", email: "a@example.com" },
      });
      f.manager.writeCreds(creds("other", 3_600_000));
      const state = await f.sync.syncCurrent();
      check("reports an unsaved login", state.unsavedIdentity?.email === "other@example.com");
      check("clears the active marker for an unsaved login", f.store.getActiveId() === undefined);
      check(
        "never copies another account's tokens into a profile",
        (await f.store.getCreds(a.id))?.refreshToken === "a1-refresh"
      );
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 2b. Another account while an older profile has no recorded identity: the owner is
    // not provable, but it is certainly not the remembered active profile.
    {
      const f = createSyncFixture({
        "other-access": { accountUuid: "acct-other", email: "other@example.com" },
      });
      await f.store.addFromCreds("Old", creds("old1", 3_600_000), { activate: false });
      await f.store.addFromCreds("A", creds("a1", 3_600_000), {
        identity: { accountUuid: "acct-a", email: "a@example.com" },
      });
      f.manager.writeCreds(creds("other", 3_600_000));
      const state = await f.sync.syncCurrent();
      check(
        "shows a different login as unsaved despite unidentified profiles",
        state.unsavedIdentity?.email === "other@example.com" && !state.ownerId
      );
      check("drops the stale active marker", f.store.getActiveId() === undefined);
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 3. A newer generation in the isolated dir is used without spending anything.
    {
      const f = createSyncFixture();
      const b = await f.store.addFromCreds("B", creds("b1", -60_000), { activate: false });
      f.manager.writeCreds(creds("b2", 3_600_000), f.homeDir(b.id));
      tokenCalls = 0;
      const fresh = await f.sync.getFreshCreds(b.id);
      check("adopts the newest generation from any copy", fresh.creds?.refreshToken === "b2-refresh");
      check("does not refresh when a valid generation exists", tokenCalls === 0);
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 4. Expired everywhere: refresh under Claude's lock and write back to every copy.
    {
      const f = createSyncFixture();
      const a = await f.store.addFromCreds("A", creds("a1", -60_000));
      f.manager.writeCreds(creds("a1", -60_000));
      tokenCalls = 0;
      let lockHeldDuringRefresh = false;
      tokenResponse = () => {
        lockHeldDuringRefresh = fs.existsSync(path.join(f.globalDir, ".oauth_refresh.lock"));
        return new Response(
          JSON.stringify({
            access_token: "a2-access",
            refresh_token: "a2-refresh",
            expires_in: 28_800,
            account: { uuid: "acct-a", email_address: "a@example.com" },
            organization: { uuid: "org-a" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };
      const fresh = await f.sync.getFreshCreds(a.id);
      check("refreshes an expired login once", fresh.ok && tokenCalls === 1);
      check("holds Claude Code's lock while spending the refresh token", lockHeldDuringRefresh);
      check(
        "writes the rotation back to Claude Code's credentials file",
        f.manager.readCurrent()?.refreshToken === "a2-refresh"
      );
      check(
        "stores the rotation in the vault",
        (await f.store.getCreds(a.id))?.refreshToken === "a2-refresh"
      );
      check("records the account identity from the token response", f.store.get(a.id)?.authAccountUuid === "acct-a");
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 5. invalid_grant: never retried; a later login in the isolated dir recovers it.
    {
      const f = createSyncFixture();
      const b = await f.store.addFromCreds("B", creds("dead", -60_000), { activate: false });
      tokenCalls = 0;
      tokenResponse = () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      const first = await f.sync.getFreshCreds(b.id);
      const second = await f.sync.getFreshCreds(b.id);
      check("invalid_grant requires reauthorization", first.needsReauthorization === true);
      check("a rejected refresh token is never sent again", second.needsReauthorization === true && tokenCalls === 1);
      f.manager.writeCreds(creds("relogin", 3_600_000), f.homeDir(b.id));
      const recovered = await f.sync.getFreshCreds(b.id);
      check("recovers as soon as a new generation appears", recovered.creds?.refreshToken === "relogin-refresh");
      check("recovery clears the dead marker", f.store.get(b.id)?.deadRefreshTokenHash === undefined);
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 6. Claude Code is refreshing right now: back off instead of racing it.
    {
      const f = createSyncFixture();
      const a = await f.store.addFromCreds("A", creds("a1", -60_000));
      f.manager.writeCreds(creds("a1", -60_000));
      fs.mkdirSync(path.join(f.globalDir, ".oauth_refresh.lock"));
      tokenCalls = 0;
      const sync = f.sync as unknown as { getFreshCreds: CredentialSync["getFreshCreds"] };
      const started = Date.now();
      const fresh = await Promise.race([
        sync.getFreshCreds(a.id),
        new Promise<{ deferred: true }>((resolve) => setTimeout(() => resolve({ deferred: true }), 20_000)),
      ]);
      check("defers while Claude Code holds the refresh lock", "deferred" in fresh && fresh.deferred === true);
      check("does not spend the token Claude Code is refreshing", tokenCalls === 0);
      check("gives up within the lock timeout", Date.now() - started < 20_000);
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 7. Switching saves the outgoing rotation, then installs the target login.
    {
      const f = createSyncFixture({
        "a2-access": { accountUuid: "acct-a", email: "a@example.com" },
      });
      const a = await f.store.addFromCreds("A", creds("a1", 3_600_000), {
        identity: { accountUuid: "acct-a", email: "a@example.com", orgId: "org-a" },
      });
      const b = await f.store.addFromCreds(
        "B",
        creds("b1", 3_600_000),
        {
          identity: { accountUuid: "acct-b", email: "b@example.com", orgId: "org-b" },
          activate: false,
        }
      );
      await f.store.setOAuthAccount(b.id, { accountUuid: "acct-b", emailAddress: "b@example.com" });
      f.manager.writeCreds(creds("a2", 7_200_000), undefined, { organizationUuid: "org-a" });
      fs.writeFileSync(
        path.join(f.globalDir, ".claude.json"),
        JSON.stringify({ keep: 1, oauthAccount: { accountUuid: "acct-a" } })
      );
      const state = await f.sync.syncCurrent();
      const installed = await f.sync.installInConfigDir(b.id, f.globalDir, state.ownerId);
      const raw = JSON.parse(fs.readFileSync(path.join(f.globalDir, ".credentials.json"), "utf8"));
      const config = JSON.parse(fs.readFileSync(path.join(f.globalDir, ".claude.json"), "utf8"));
      check("switch succeeds", installed.ok === true && f.store.getActiveId() === b.id);
      check(
        "outgoing profile keeps Claude Code's latest rotation",
        (await f.store.getCreds(a.id))?.refreshToken === "a2-refresh"
      );
      check("target tokens are written", raw.claudeAiOauth.refreshToken === "b1-refresh");
      check("organizationUuid follows the target account", raw.organizationUuid === "org-b");
      check(
        "Claude Code's cached oauthAccount follows the target account",
        config.oauthAccount.accountUuid === "acct-b" && config.keep === 1
      );
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLAUDE_CONFIG_DIR;
  }
}

async function runRequestQueueTests(): Promise<void> {
  console.log("request queue:");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const q = new RequestQueue(60);
  const log: string[] = [];
  const spans: [number, number][] = [];
  const job = (name: string, ms: number, fail = false) => async () => {
    const start = Date.now();
    log.push(name + ":start");
    await sleep(ms);
    spans.push([start, Date.now()]);
    log.push(name + ":end");
    if (fail) throw new Error(name + " failed");
    return name;
  };
  const results = await Promise.allSettled([q.run(job("a", 30)), q.run(job("b", 10, true)), q.run(job("c", 20))]);
  check("requests run one at a time, in the order they were queued", log.join() === "a:start,a:end,b:start,b:end,c:start,c:end", log.join());
  const gaps = spans.slice(1).map((s, i) => s[0] - spans[i][1]);
  check("each request waits the gap after the previous one ended", gaps.every((g) => g >= 55), JSON.stringify(gaps));
  check("a failing request rejects only its own caller", results[0].status === "fulfilled" && results[1].status === "rejected" && results[2].status === "fulfilled");
  check("results come back to their callers", (results[0] as PromiseFulfilledResult<string>).value === "a" && (results[2] as PromiseFulfilledResult<string>).value === "c");
  q.setGap(0);
  const t0 = Date.now();
  await q.run(job("d", 0));
  check("the gap can be changed (0 = no pause)", Date.now() - t0 < 40 && q.gap === 0);
  q.setGap(-5);
  check("a negative gap counts as 0", q.gap === 0);

  // The poller: three accounts are checked one after another, never in parallel, with the pause.
  const originalFetch = globalThis.fetch;
  const f = createSyncFixture();
  const ids: string[] = [];
  for (const n of ["p", "q", "r"]) {
    const acc = await f.store.addFromCreds(n.toUpperCase(), creds(n + "1", 3_600_000));
    ids.push(acc.id);
  }
  let inFlight = 0;
  let maxInFlight = 0;
  const usageSpans: [number, number][] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth/usage")) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const start = Date.now();
      await sleep(15);
      inFlight--;
      usageSpans.push([start, Date.now()]);
      return new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: null } }), { status: 200 });
    }
    if (url.includes("/oauth/profile")) {
      return new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  anthropicQueue.setGap(50);
  try {
    const poller = new UsagePoller(f.store, f.sync, () => 240, () => undefined);
    // A full poll plus a card refresh and a re-check arriving at the same time.
    await Promise.all([poller.pollAll(true), poller.pollOne(ids[0], true), poller.pollOne(ids[2], true)]);
    check("usage requests never overlap, even from different callers", maxInFlight === 1, `max ${maxInFlight} at once`);
    check("all requests were made (3 accounts + 2 extra refreshes)", usageSpans.length === 5, String(usageSpans.length));
    const pauses = usageSpans.slice(1).map((s, i) => s[0] - usageSpans[i][1]);
    check("there is a pause between consecutive usage requests", pauses.every((p) => p >= 45), JSON.stringify(pauses));
    check("every account got its usage", ids.every((id) => f.store.get(id)?.lastUsage?.sessionPercent === 12));
  } finally {
    anthropicQueue.setGap(0);
    globalThis.fetch = originalFetch;
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

async function runUsagePollerTests(): Promise<void> {
  console.log("UsagePoller:");
  const originalFetch = globalThis.fetch;
  const f = createSyncFixture();
  const a = await f.store.addFromCreds("A", creds("a1", 3_600_000));
  f.manager.writeCreds(creds("a1", 3_600_000));
  let usageCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth/usage")) {
      usageCalls++;
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === "Bearer a2-access"
        ? new Response(JSON.stringify({ five_hour: { utilization: 7, resets_at: null } }), { status: 200 })
        : new Response("unauthorized", { status: 401 });
    }
    if (url.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({ access_token: "a2-access", refresh_token: "a2-refresh", expires_in: 28_800 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const poller = new UsagePoller(f.store, f.sync, () => 240, () => undefined);
    await poller.pollOne(a.id, true);
    check("a 401 triggers one locked refresh and a retry", usageCalls === 2);
    check("usage is stored after the retry", f.store.get(a.id)?.lastUsage?.sessionPercent === 7);
    check(
      "the retry's rotation reaches Claude Code's file",
      f.manager.readCurrent()?.refreshToken === "a2-refresh"
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

async function runSwitchServiceTests(): Promise<void> {
  console.log("SwitchService:");

  const f = createSyncFixture();
  const profile = await f.store.addFromCreds("Newater2", {
    accessToken: "stored-access",
    refreshToken: "",
    expiresAt: 111,
    scopes: [],
  });
  f.manager.writeCreds({
    accessToken: "current-access",
    refreshToken: "current-refresh",
    expiresAt: 222,
    scopes: ["user:profile"],
  });

  const service = new SwitchService(f.store, f.manager, f.sync);
  const switchResult = await service.switchTo(profile.id);
  check(
    "incomplete profile switch requests reauthorization",
    !switchResult.ok && switchResult.reauthProfileId === profile.id
  );
  check(
    "switch does not store current login into incomplete profile",
    (await f.store.getCreds(profile.id))?.refreshToken === ""
  );

  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function runTokenRefresherTests(): Promise<void> {
  console.log("TokenRefresher:");
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
        scope: "user:profile user:inference",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const before = Date.now();
    const refreshed = await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 111,
      refreshTokenExpiresAt: 222,
      scopes: ["user:profile", "user:inference"],
      clientId: "custom-client",
    });
    const body = JSON.parse(String(capturedInit?.body));
    const headers = capturedInit?.headers as Record<string, string>;

    check("uses current Claude Code token endpoint", capturedUrl === "https://platform.claude.com/v1/oauth/token");
    check("sends JSON token refresh body", headers["Content-Type"] === "application/json");
    check("sends oauth beta header", headers["anthropic-beta"] === "oauth-2025-04-20");
    check("sends user agent", headers["User-Agent"] === "claude-code-account-switcher");
    check("includes grant type", body.grant_type === "refresh_token");
    check("includes refresh token", body.refresh_token === "old-refresh");
    check("uses credential clientId when present", body.client_id === "custom-client");
    check("includes credential scopes", body.scope === "user:profile user:inference");
    check("stores rotated access token", refreshed.creds?.accessToken === "next-access");
    check("stores rotated refresh token", refreshed.creds?.refreshToken === "next-refresh");
    check("stores refresh token expiry", (refreshed.creds?.refreshTokenExpiresAt ?? 0) >= before + 7_199_000);
    check("updates response scopes", refreshed.creds?.scopes.join(" ") === "user:profile user:inference");

    capturedInit = undefined;
    await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 111,
      scopes: [],
    });
    const defaultScopeBody = JSON.parse(String(capturedInit?.body));
    check(
      "uses default Claude Code scopes when missing",
      defaultScopeBody.scope ===
        "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins"
    );

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const missingRefresh = await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "",
      expiresAt: 111,
      scopes: [],
    });
    check("does not request without refresh token", !missingRefresh.ok && fetchCalls === 0);
    check("missing refresh token requires reauthorization", missingRefresh.requiresReauthorization === true);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token not found or invalid",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;
    const invalidGrant = await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "dead-refresh",
      expiresAt: 111,
      scopes: ["user:profile"],
    });
    check("invalid_grant requires reauthorization", invalidGrant.requiresReauthorization === true);
    check("invalid_grant error stays recognizable", requiresProfileReauthorization(invalidGrant.error));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runBackupTests(): Promise<void> {
  console.log("backup / restore / reorder:");
  const creds = (access: string, expiresAt: number): OAuthCreds => ({
    accessToken: access,
    refreshToken: access + "-refresh",
    expiresAt,
    subscriptionType: "pro",
  });
  const source = createStore();
  const a = await source.addFromCreds("A", creds("a1", 1000), {
    identity: { accountUuid: "acc-a", email: "a@example.com" },
  });
  const b = await source.addFromCreds("B", creds("b1", 1000), {
    identity: { accountUuid: "acc-b", email: "b@example.com" },
  });
  await source.updateUsage(a.id, { fetchedAt: 1, windows: [], sessionPercent: 5, weeklyPercent: 5 });

  await source.reorder([b.id, a.id]);
  check("reorder persists the new order", source.list().map((p) => p.label).join() === "B,A");

  const zip = await createBackupZip(await source.exportAll(), "correct horse", "0.0.0", {
    view: { sort: "available", plan: "pro" },
    config: { pollIntervalSeconds: 120 },
  });
  check("backup is a ZIP archive", zip[0] === 0x50 && zip[1] === 0x4b);
  check("backup does not contain plain-text tokens", !Buffer.from(zip).toString("latin1").includes("a1-refresh"));

  let wrongPassword = "";
  try {
    await readBackupZip(zip, "wrong password");
  } catch (e) {
    wrongPassword = (e as Error).message;
  }
  check("wrong backup password is rejected", wrongPassword === "Wrong password.");

  const contents = await readBackupZip(zip, "correct horse");
  const entries = contents.accounts;
  check(
    "backup round-trips view and extension settings",
    contents.settings?.view?.sort === "available" && contents.settings?.config?.pollIntervalSeconds === 120
  );
  check("backup round-trips all accounts", entries.length === 2);
  check("backup omits usage snapshots", entries.every((e) => e.profile.lastUsage === undefined));

  const fresh = createStore();
  const first = await fresh.restore(entries);
  check("restore adds missing accounts", first.added === 2 && fresh.list().length === 2);
  check("restore keeps backup order", fresh.list().map((p) => p.label).join() === "B,A");
  check("restore stores tokens", (await fresh.getCreds(a.id))?.accessToken === "a1");

  // The live profile has rotated since the backup: an old backup must not roll it back.
  await fresh.updateCreds(a.id, creds("a2", 2000));
  const second = await fresh.restore(entries);
  check("restore does not duplicate existing accounts", second.added === 0 && fresh.list().length === 2);
  check("restore keeps newer live tokens", (await fresh.getCreds(a.id))?.accessToken === "a2");
}

function runLimitResetTests(): void {
  console.log("limit reset detection:");
  const snap = (windows: [string, number][]): UsageSnapshot => ({
    fetchedAt: 0,
    sessionPercent: null,
    weeklyPercent: null,
    windows: windows.map(([kind, percent]) => ({ kind, label: kind, percent, severity: "normal", resetsAt: null })),
  });
  const reset = findResetWindows(
    snap([["session", 100], ["weekly_all", 100], ["weekly_fable", 100]]),
    snap([["session", 0], ["weekly_all", 100], ["weekly_fable", 3]])
  );
  check("detects reset session and model limits", reset.map((w) => w.kind).join() === "session,weekly_fable");
  check("no reset without previous snapshot", findResetWindows(undefined, snap([["session", 0]])).length === 0);
  check("no reset when limit was not used up", findResetWindows(snap([["session", 99]]), snap([["session", 0]])).length === 0);
  const fable = parseUsage({ limits: [{ kind: "weekly_fable", group: "weekly", percent: 4 }] });
  check("labels model-specific weekly limits", fable.windows[0].label === "Weekly (Fable)");
  // Shape returned by the usage endpoint: the model is in `scope`, the kind is generic.
  const scoped = parseUsage({
    limits: [
      { kind: "session", group: "session", percent: 7, scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 24,
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
  });
  check(
    "reads the model of a scoped weekly limit",
    scoped.windows[1].kind === "weekly_fable" && scoped.windows[1].label === "Weekly (Fable)"
  );
  const legacy = parseUsage({
    five_hour: { utilization: 10, resets_at: null },
    seven_day: { utilization: 20, resets_at: null },
    seven_day_fable: { utilization: 30, resets_at: null },
    seven_day_opus: null,
  });
  check(
    "parses scoped weekly windows from the legacy shape",
    legacy.windows.map((w) => `${w.kind}:${w.label}:${w.percent}`).join() ===
      "session:Session (5h):10,weekly_all:Weekly (all):20,weekly_fable:Weekly (Fable):30"
  );
}

async function runUsageHistoryTests(): Promise<void> {
  console.log("usage history:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-"));
  const history = new UsageHistory(dir);
  const snap = (session: number, fable: number): UsageSnapshot => ({
    fetchedAt: 0,
    sessionPercent: session,
    weeklyPercent: null,
    windows: [
      { kind: "session", label: "Session (5h)", percent: session, severity: "normal", resetsAt: null },
      { kind: "weekly_fable", label: "Weekly (Fable)", percent: fable, severity: "normal", resetsAt: null },
    ],
  });
  const t0 = Date.UTC(2026, 0, 31, 23, 0);
  check("records the first reading", await history.record("a", snap(10, 5), { label: "A" }, t0));
  check("skips an unchanged reading", !(await history.record("a", snap(10, 5), { label: "A" }, t0 + 60_000)));
  check("records a changed reading", await history.record("a", snap(12, 5), { label: "A" }, t0 + 120_000));
  check(
    "records an unchanged reading after the heartbeat",
    await history.record("a", snap(12, 5), { label: "A" }, t0 + 120_000 + HISTORY_HEARTBEAT_MS)
  );
  // Next month (February): a separate file.
  await history.record("b", snap(1, 2), { label: "B" }, Date.UTC(2026, 1, 1, 1, 0));

  const all = await history.query(t0 - 1, Date.UTC(2026, 1, 2));
  check("queries across month files", all.length === 4 && all[3].id === "b");
  check("keeps limit values per kind", all[1].w.session === 12 && all[1].w.weekly_fable === 5);
  check("keeps window labels", all[0].n?.weekly_fable === "Weekly (Fable)");
  check("filters by time range", (await history.query(t0 + 60_000, t0 + 130_000)).length === 1);

  await history.prune(10, Date.UTC(2026, 1, 20));
  const afterPrune = await history.query(0, Date.UTC(2026, 2, 1));
  check("prune removes months past retention", afterPrune.length === 1 && afterPrune[0].id === "b");
  fs.rmSync(dir, { recursive: true, force: true });
}

function runUtilizationTests(): void {
  console.log("capacity utilization:");
  const h = 3_600_000;
  const pt = (id: string, t: number, session: number, fable?: number): HistoryPoint => ({
    t,
    id,
    w: fable === undefined ? { session } : { session, weekly_fable: fable },
  });

  check("cycles: 5h for the session limit, 7 days for every weekly limit", cycleMs("session") === 5 * h && cycleMs("weekly_fable") === 7 * 24 * h && cycleMs("weekly_all") === 7 * 24 * h);
  check("usage between readings: increases count, a drop is a reset", usedBetween(10, 40) === 30 && usedBetween(90, 15) === 15 && usedBetween(50, 50) === 0);

  // One account, readings every 10 min: 0 -> 100% across exactly 5 h, then reset to 0 and 50% in the next 5 h.
  const a: HistoryPoint[] = [];
  for (let i = 0; i <= 30; i++) a.push(pt("a", i * 10 * 60_000, Math.min(100, Math.round((i / 30) * 100))));
  for (let i = 1; i <= 30; i++) a.push(pt("a", 5 * h + i * 10 * 60_000, Math.min(50, Math.round((i / 30) * 50))));
  const used10h = usedCapacityIn(a, "session", 0, 10 * h)!;
  check("used capacity over 10 h: 100% + 50% = 150%", Math.round(used10h) === 150, String(used10h));
  check("10 h offers two 5 h budgets: utilization 75%", Math.round(utilizationIn(a, "session", 0, 10 * h)!) === 75);
  check("the first 5 h alone: 100%", Math.round(utilizationIn(a, "session", 0, 5 * h)!) === 100);
  check("the second 5 h alone: 50%", Math.round(utilizationIn(a, "session", 5 * h, 10 * h)!) === 50);
  check("a window without any readings: null, not 0", usedCapacityIn(a, "session", 20 * h, 25 * h) === null);
  check("an increase spanning a window edge is split by time", Math.round(usedCapacityIn(a, "session", 0, 2.5 * h)!) === 50);

  // Gaps: two readings 2 hours apart (collection was off): nothing is counted across the gap.
  const gap = [pt("g", 0, 10), pt("g", 2 * h, 80), pt("g", 2 * h + 60_000, 82)];
  check("a long gap between readings counts nothing", Math.round(usedCapacityIn(gap, "session", 0, 3 * h)!) === 2);
  check("covered spans leave the gap out", JSON.stringify(coveredSpans(gap, 0, 3 * h)) === JSON.stringify([[2 * h, 2 * h + 60_000]]));

  // Two accounts over a 7-day Fable cycle, read every 20 minutes (readings further apart than
  // CARRY_MS count as a collection gap): "a" climbs to 70%, "b" to 30%.
  const week: HistoryPoint[] = [];
  const steps = 7 * 24 * 3;
  for (let i = 0; i <= steps; i++) {
    const t = i * 20 * 60_000;
    week.push(pt("fa", t, 0, (i / steps) * 70));
    week.push(pt("fb", t, 0, (i / steps) * 30));
  }
  const both = utilizationSummary(week, ["fa", "fb"], "weekly_fable", "Weekly (Fable)", 0, 7 * 24 * h);
  check("Fable over the week: a 70%, b 30%", both.accounts[0].utilization === 70 && both.accounts[1].utilization === 30, JSON.stringify(both.accounts));
  check("together: (70 + 30) / (2 budgets) = 50%", both.overall === 50, String(both.overall));
  check("budgets reported: 1.0 used of 2 offered", both.usedBudgets === 1 && both.offeredBudgets === 2, `${both.usedBudgets}/${both.offeredBudgets}`);
  const onlyA = utilizationSummary(week, ["fa"], "weekly_fable", "Weekly (Fable)", 0, 7 * 24 * h);
  check("selecting one account changes the overall figure", onlyA.overall === 70);
  const none = utilizationSummary(week, ["zz"], "weekly_fable", "Weekly (Fable)", 0, 7 * 24 * h);
  check("an account without readings: no utilization, no capacity", none.overall === null && none.accounts[0].utilization === null);

  // Partial coverage: an account watched only for the last 3.5 days of the week must not be charged for 7.
  const half: HistoryPoint[] = [];
  const halfSteps = (3.5 * 24 * 60) / 20;
  for (let i = 0; i <= halfSteps; i++) half.push(pt("h", 3.5 * 24 * h + i * 20 * 60_000, 0, (i / halfSteps) * 35));
  const partial = utilizationSummary(half, ["h"], "weekly_fable", "Weekly (Fable)", 0, 7 * 24 * h);
  check("only the watched part of the range is offered capacity", partial.offeredBudgets === 0.5 && partial.overall === 70, `${partial.offeredBudgets} ${partial.overall}`);

  // Series: 1-day buckets over the week for the two Fable accounts (steady climb => the same every day).
  const s = utilizationSeries(week, ["fa", "fb"], "weekly_fable", 0, 7 * 24 * h, 24 * h);
  check("series: one value per bucket", s.starts.length === 7 && s.values.length === 7);
  check("series: each day uses 1/7 of the week's budget at 50% together", s.values.every((v) => v === 50), JSON.stringify(s.values));
  check("series: per account 70% and 30% each day", s.perAccount[0].every((v) => v === 70) && s.perAccount[1].every((v) => v === 30));
  // ---- breakdown by calendar period (local time: build the fixture from local dates)
  const local = (y: number, mo: number, d: number, hr = 0) => new Date(y, mo - 1, d, hr).getTime();
  // Mon 2026-10-05 00:00 .. Mon 2026-10-19 00:00 (two whole ISO weeks, 41 and 42), 20-minute readings.
  const pFrom = local(2026, 10, 5);
  const pTo = local(2026, 10, 19);
  const wk: HistoryPoint[] = [];
  for (let t = pFrom; t <= pTo; t += 20 * 60_000) {
    const d = new Date(t);
    // Account "wd": busy on Mondays (5h limit climbs to 100% within each cycle), idle otherwise.
    const cyclePhase = ((t - pFrom) % (5 * h)) / (5 * h);
    wk.push({ t, id: "wd", w: { session: d.getDay() === 1 ? Math.round(cyclePhase * 100) : 0 } });
    // Account "w2": only watched in week 42, steady 50% of each cycle.
    if (t >= local(2026, 10, 12)) wk.push({ t, id: "w2", w: { session: Math.round(cyclePhase * 50) } });
  }
  const slicesWd = periodSlices("weekday", pFrom, pTo);
  check("period slices: 14 day slices for two weeks, Monday first in the range", slicesWd.length === 14 && slicesWd[0].label === "Mon" && slicesWd[13].label === "Sun");
  check("period slices: weeks are keyed by ISO week", JSON.stringify([...new Set(periodSlices("week", pFrom, pTo).map((x) => x.key))]) === '["2026-W41","2026-W42"]');
  check("period slices: a month key and label", periodSlices("month", pFrom, pTo)[0].key === "2026-10" && periodSlices("month", pFrom, pTo)[0].label === "Oct 2026");
  check("period slices: hours are keyed 0..23", periodSlices("hour", local(2026, 10, 5, 22), local(2026, 10, 6, 2)).map((x) => x.key).join() === "22,23,0,1");
  const byDay = utilizationByPeriod(wk, ["wd"], "session", "weekday", pFrom, pTo);
  check("by weekday: seven groups, Monday first", byDay.length === 7 && byDay[0].label === "Mon" && byDay[6].label === "Sun", byDay.map((b) => b.label).join());
  // A 5h cycle does not divide a day: the last Monday cycle finishes in Tuesday's first hour, and
  // the reading at the range's end (a Monday 00:00) carries Sunday's cycle. So Monday is high but
  // not 100, Tuesday gets a little spill-over, and Wednesday..Saturday are exactly 0.
  check("by weekday: both Mondays merged into one high group, Wed..Sat at 0%", byDay[0].utilization !== null && byDay[0].utilization >= 90 && byDay.slice(2, 6).every((b) => b.utilization === 0) && (byDay[1].utilization ?? 0) < 15, JSON.stringify(byDay.map((b) => b.label + ":" + b.utilization)));
  check("by weekday: Monday offers two days of 5h budgets (2 * 24/5 = 9.6)", byDay[0].offeredBudgets === 9.6, String(byDay[0].offeredBudgets));
  const byWeek = utilizationByPeriod(wk, ["wd", "w2"], "session", "week", pFrom, pTo);
  check("by week: two consecutive weeks in order", byWeek.map((b) => b.label).join() === "W41,W42", byWeek.map((b) => b.label).join());
  check("by week: an account only watched in week 42 has no data in week 41 but counts in 42", byWeek[0].perAccount[1] === null && byWeek[1].perAccount[1] !== null && byWeek[1].perAccount[1] >= 45 && byWeek[1].perAccount[1] <= 50, JSON.stringify(byWeek.map((b) => b.perAccount)));
  check("by week: the combined figure only offers capacity for watched time", byWeek[0].offeredBudgets === 33.6 && byWeek[1].offeredBudgets === 67.2, `${byWeek[0].offeredBudgets} ${byWeek[1].offeredBudgets}`);
  const byMonth = utilizationByPeriod(wk, ["wd"], "session", "month", pFrom, pTo);
  check("by month: one month, utilization = Monday share of a fortnight (2/14 of ~100%)", byMonth.length === 1 && byMonth[0].label === "Oct 2026" && byMonth[0].utilization !== null && Math.abs(byMonth[0].utilization - 14.3) < 1, JSON.stringify(byMonth));
  check("by period: an unknown account gives empty groups, not a crash", utilizationByPeriod(wk, ["zz"], "session", "weekday", pFrom, pTo).every((b) => b.utilization === null));

  const sa = utilizationSeries(a, ["a", "nobody"], "session", 0, 10 * h, 5 * h);
  check("series: 5h buckets of the session account: 100% then 50%; an account without data is skipped", JSON.stringify(sa.values) === "[100,50]" && sa.perAccount[1].every((v) => v === null), JSON.stringify(sa.values));
  check("utilization never exceeds 100% (readings are rounded percents)", utilizationIn([pt("r", 0, 0), pt("r", 60_000, 100), pt("r", 120_000, 0), pt("r", 180_000, 100)], "session", 0, 180_000) === 100);
}

function runHistorySeriesTests(): void {
  console.log("history series:");
  const m = 60_000;
  const p = (t: number, session: number, fable?: number): HistoryPoint => ({
    t: t * m,
    id: "a",
    w: fable === undefined ? { session } : { session, weekly_fable: fable },
    n: { session: "Session (5h)", weekly_fable: "Weekly (Fable)" },
  });
  // Minutes 0..60: 10% -> 30% -> reset -> 5%, then a long gap, then 50% at minute 200.
  const points = [p(-5, 8), p(0, 10, 1), p(20, 30), p(40, 5), p(200, 50)];

  check(
    "kinds ordered session first",
    kindsIn(points).map((k) => `${k.kind}:${k.label}`).join() === "session:Session (5h),weekly_fable:Weekly (Fable)"
  );
  check("bucket size keeps about 100 buckets", bucketSizeFor(86_400_000) === 15 * m);

  const used = bucketSeries(points, "a", "session", 0, 120 * m, 30 * m, "used");
  check("used: highest percent per bucket, carried over, a gap after 30 min", JSON.stringify(used) === "[30,30,5,null]");
  const available = bucketSeries(points, "a", "session", 0, 120 * m, 30 * m, "available");
  check("available: what was left at the busiest point of each bucket", JSON.stringify(available) === "[70,70,95,null]");
  check("other accounts are ignored", bucketSeries(points, "b", "session", 0, 60 * m, 30 * m, "used").every((v) => v === null));
  check("pie total: the average over buckets with data", seriesTotal([30, 5, null]) === 17.5 && seriesTotal([null]) === null);
}

function runAvailabilityTests(): void {
  console.log("availability timeline:");
  const h = 3_600_000;
  const iso = (t: number) => new Date(t).toISOString();
  const points: HistoryPoint[] = [
    { t: 1 * h, id: "a", w: { session: 50 }, n: { session: "Session (5h)" } },
    { t: 1.5 * h, id: "a", w: { session: 100 }, n: { session: "Session (5h)" } },
  ];
  const account = {
    id: "a",
    windows: [
      { kind: "session", label: "Session (5h)", percent: 100, resetsAt: iso(6 * h) },
      { kind: "weekly_fable", label: "Weekly (Fable)", percent: 20, resetsAt: iso(12 * h) },
    ],
  };
  const t = buildTimeline(account, points, 0, 10 * h, 4 * h);
  const fmt = (segs: Segment[]) =>
    segs.map((s) => `${s.start / h}-${s.end / h}:${s.state}${s.projected ? "*" : ""}`).join(" ");

  check("lanes ordered session first", t.lanes.map((l) => l.kind).join() === "session,weekly_fable");
  check(
    "session lane: history, gap, projection until the reset, then free",
    fmt(t.lanes[0].segments) === "0-1:nodata 1-1.5:free 1.5-2:limited 2-4:nodata 4-6:limited* 6-10:free*"
  );
  check("reset marker at the reset time", t.lanes[0].resets.join() === String(6 * h));
  check("fable lane: unknown past, projected free", fmt(t.lanes[1].segments) === "0-4:nodata 4-10:free*");
  check(
    "overall lane: blocked while any limit is, free only when all are known",
    fmt(t.overall) === "0-1.5:nodata 1.5-2:limited 2-4:nodata 4-6:limited* 6-10:free*"
  );
  check("next available at the blocking reset", t.nextAvailableAt === 6 * h);

  // Per-account stats from the overall lane: 0-1.5 nodata, 1.5-2 limited, 2-4 nodata (past = 4 h); 4-6 limited*, 6-10 free* (future = 6 h).
  const st = timelineStats(t.overall);
  check("stats: past split by state (limited 0.5 h of 4 h = 12.5%, nodata 87.5%)", st.past.limited === 12.5 && st.past.nodata === 87.5 && st.past.free === 0, JSON.stringify(st.past));
  check("stats: future split (limited 2 h of 6 h = 33.3%, free 66.7%)", st.future.limited === 33.3 && st.future.free === 66.7, JSON.stringify(st.future));
  check("stats: past and future durations", st.pastMs === 4 * h && st.futureMs === 6 * h);
  check("stats: one blocked stretch, 30 min long, in the past", st.blockedCount === 1 && st.longestBlockedMs === 0.5 * h);
  const twice = timelineStats([
    { start: 0, end: h, state: "limited", projected: false },
    { start: h, end: 2 * h, state: "free", projected: false },
    { start: 2 * h, end: 5 * h, state: "limited", projected: false },
  ]);
  check("stats: separate blocked stretches are counted, the longest kept", twice.blockedCount === 2 && twice.longestBlockedMs === 3 * h && twice.past.limited === 80);
  check("stats: an empty lane gives zeros, not NaN", timelineStats([]).past.free === 0 && timelineStats([]).pastMs === 0);
}

function runListingTests(): void {
  console.log("account listing (sort and filters):");
  const h = 3_600_000;
  const now = Date.now();
  const win = (kind: string, label: string, percent: number, resetIn?: number) => ({
    kind,
    label,
    percent,
    resetsAt: resetIn === undefined ? null : new Date(now + resetIn).toISOString(),
  });
  const accounts: ListAccount[] = [
    { id: "limitedLate", label: "Limited late", subscriptionType: "pro", windows: [win("session", "Session (5h)", 100, 50 * h)] },
    {
      id: "avail30",
      label: "Avail 30%",
      subscriptionType: "Team",
      windows: [win("session", "Session (5h)", 30, 3 * h), win("weekly_fable", "Weekly (Fable)", 20, 100 * h)],
    },
    { id: "unknown", label: "Unknown", windows: [] },
    {
      id: "limitedSoon",
      label: "Limited soon",
      subscriptionType: "max",
      windows: [win("session", "Session (5h)", 100, 2 * h), win("weekly_all", "Weekly (all)", 40, 1 * h)],
    },
    { id: "avail80", label: "Avail 80%", subscriptionType: "free", isActive: true, windows: [win("session", "Session (5h)", 80, 10 * h)] },
  ];
  const order = new Map(accounts.map((a, i) => [a.id, i]));
  const sorted = (sort: SortKey) => sortAccounts(accounts, order, sort).map((a) => a.id).join(">");
  const shown = (patch: Partial<typeof DEFAULT_LISTING>) =>
    accounts.filter((a) => matchesListing(a, { ...DEFAULT_LISTING, ...patch })).map((a) => a.id).join();

  check("custom keeps the user's order", sorted("custom") === "limitedLate>avail30>unknown>limitedSoon>avail80");
  check("available first: most headroom, unknown, then soonest to free up", sorted("available") === "avail30>avail80>unknown>limitedSoon>limitedLate");
  check("most usage left first, ties in custom order", sorted("remaining") === "avail30>avail80>limitedLate>limitedSoon>unknown");
  check("resetting soonest first, unknown last", sorted("reset") === "limitedSoon>avail30>avail80>limitedLate>unknown");
  check("plan: team, max, pro, free, unknown", sorted("plan") === "avail30>limitedSoon>limitedLate>avail80>unknown");
  // Fable resets: f1 in 50 h, f2 in 5 h, f3 has no Fable limit, f4 has one without a reset time.
  const fable = (id: string, resetIn: number | undefined): ListAccount => ({
    id,
    label: id,
    windows: [{ kind: "weekly_fable", label: "Weekly (Fable)", percent: 40, resetsAt: resetIn === undefined ? null : new Date(now + resetIn).toISOString() }],
  });
  const fableAccounts: ListAccount[] = [fable("f1", 50 * h), fable("f2", 5 * h), { id: "f3", label: "f3", windows: [win("session", "Session (5h)", 10, h)] }, fable("f4", undefined)];
  check(
    "Fable reset: soonest first, then accounts without a Fable reset in custom order",
    sortAccounts(fableAccounts, new Map(fableAccounts.map((a, i) => [a.id, i])), "resetFable").map((a) => a.id).join(">") === "f2>f1>f3>f4"
  );
  check("the Fable reset sort is offered and valid in saved settings", SORTS.some((s) => s.key === "resetFable") && normalizeListing({ sort: "resetFable" }).sort === "resetFable");
  check("name A-Z ignores case", sorted("name") === "avail30>avail80>limitedLate>limitedSoon>unknown");
  check("sorting does not change the input", accounts.map((a) => a.id).join() === "limitedLate,avail30,unknown,limitedSoon,avail80");

  check("filter: available", shown({ limit: "available" }) === "avail30,avail80");
  check("filter: limited", shown({ limit: "limited" }) === "limitedLate,limitedSoon");
  check("filter: plan", shown({ plan: "team" }) === "avail30");
  check("filter: with a Fable limit", shown({ scope: "has:fable" }) === "avail30");
  check("filter: without a Fable limit", shown({ scope: "no:fable" }) === "limitedLate,unknown,limitedSoon,avail80");
  check("filter: text matches the plan, name, and 'active'", shown({ text: "TEAM" }) === "avail30" && shown({ text: "late" }) === "limitedLate" && shown({ text: "active" }) === "avail80");
  check("filters combine", shown({ limit: "available", plan: "free" }) === "avail80");
  check("scopes list model limits, not the general weekly one", JSON.stringify(scopesOf(accounts[1])) === '{"fable":"Fable"}' && Object.keys(scopesOf(accounts[3])).length === 0);

  check("normalize accepts good settings", JSON.stringify(normalizeListing({ text: "x", limit: "limited", plan: " Pro ", scope: "has:fable", sort: "plan" })) ===
    JSON.stringify({ text: "x", limit: "limited", plan: "pro", scope: "has:fable", sort: "plan" }));
  check("normalize falls back per field", JSON.stringify(normalizeListing({ sort: "bogus", limit: 3, scope: "weird", plan: "", text: 5 })) === JSON.stringify(DEFAULT_LISTING));
  check("normalize survives junk", JSON.stringify(normalizeListing(null)) === JSON.stringify(DEFAULT_LISTING) && JSON.stringify(normalizeListing("x")) === JSON.stringify(DEFAULT_LISTING));
  check("filter descriptions", extraFilterLabels({ ...DEFAULT_LISTING, plan: "team", scope: "no:fable" }).join() === "Team,without fable limit");
  check("sort alone is not a filter", !filtersActive({ ...DEFAULT_LISTING, sort: "name" }) && filtersActive({ ...DEFAULT_LISTING, text: "a" }));
}

function runAvatarTests(): void {
  console.log("account icon:");
  const win = (percent: number) => [{ kind: "session", label: "Session (5h)", percent, resetsAt: null }];
  const acc = (windows: ReturnType<typeof win>, extra: { needsReauthorization?: boolean } = {}) => ({
    id: "x",
    label: "X",
    windows,
    ...extra,
  });
  check("green while a limit is left", avatarState(acc(win(30))) === "available" && AVATAR_COLORS.available === "#3c9d5d");
  check("still green at 80%+ (a limit is left)", avatarState(acc(win(99))) === "available");
  check("orange once a limit is used up", avatarState(acc(win(100))) === "limited" && AVATAR_COLORS.limited === "#d97757");
  check(
    "orange when any one limit is used up",
    avatarState(acc([...win(10), { kind: "weekly_fable", label: "Weekly (Fable)", percent: 100, resetsAt: null }])) === "limited"
  );
  check("gray without usage data", avatarState(acc([])) === "unknown");
  check("gray for an expired login, whatever its last usage said", avatarState(acc(win(10), { needsReauthorization: true })) === "unknown");
  check(
    "tooltip text names the state",
    avatarDescription(acc(win(10))) === "limit available" &&
      avatarDescription(acc(win(100))) === "limit used up" &&
      avatarDescription(acc([])) === "usage unknown" &&
      avatarDescription(acc(win(10), { needsReauthorization: true })) === "login expired"
  );
  check("the mark is one path with a ray per segment", /^<path d="(M[\d. ]+L[\d. ]+){12}"\/>$/.test(starburstGlyph(12)));
}

function runResetToneTests(): void {
  console.log("reset time colors:");
  const min = 60_000;
  const hour = 60 * min;
  check("under 10 minutes: yellow", resetTone(100, 9 * min) === "imminent" && resetTone(100, 0) === "imminent");
  check("10 to 60 minutes: orange", resetTone(100, 10 * min) === "soon" && resetTone(100, 59 * min) === "soon");
  check("1 hour to 1 day: no color", resetTone(100, 60 * min) === undefined && resetTone(100, 24 * hour) === undefined);
  check("more than a day: red", resetTone(100, 24 * hour + 1) === "far" && resetTone(100, 6 * 24 * hour) === "far");
  check(
    "a limit with some left is never colored",
    resetTone(99, 5 * min) === undefined && resetTone(60, 30 * min) === undefined && resetTone(24, 6 * 24 * hour) === undefined
  );
  check("a reset time already past counts as imminent", resetTone(100, -5 * min) === "imminent");
}

function runProposeTests(): void {
  console.log("account proposals:");
  const h = 3_600_000;
  const now = Date.UTC(2026, 9, 13, 12, 0);
  const at = (ms: number) => new Date(now + ms).toISOString();
  const w = (kind: string, percent: number, resetIn: number | null = 2 * h) => ({ kind, label: kind, percent, resetsAt: resetIn === null ? null : at(resetIn) });
  const acc = (id: string, windows: ReturnType<typeof w>[], extra: { isActive?: boolean; needsReauthorization?: boolean } = {}) => ({ id, label: id, windows, ...extra });
  const ids = (list: { id: string }[]) => list.map((x) => x.id).join();

  // Urgency = available % per hour until reset.
  check("urgency: 40% left with 1 h to go (40/h) beats 90% left with 5 h to go (18/h)", urgencyOf(w("session", 60, 1 * h), "session", now) > urgencyOf(w("session", 10, 5 * h), "session", now));
  check("a reset within minutes with capacity left is the most urgent of all", urgencyOf(w("session", 50, 3 * 60_000), "session", now) === Infinity);
  check("nothing available: no urgency", urgencyOf(w("session", 100, 60_000), "session", now) === 0);
  check("an unknown reset time assumes a full cycle (5 h for 5h, a week for weekly)", urgencyOf(w("session", 50, null), "session", now) === 10 && Math.abs(urgencyOf(w("weekly_fable", 16, null), "weekly_fable", now) - 0.5) < 1e-9);

  const accounts = [
    acc("fresh", [w("session", 2, 4.5 * h)]), // 98% / 4.5 h = 21.8 per h
    acc("soon", [w("session", 60, 59 * 60_000)]), // 40% in 59 min -> most urgent
    acc("mid", [w("session", 30, 3 * h), w("weekly_fable", 60, 50 * h)]), // 70 / 3 = 23.3 per h
    acc("active", [w("session", 7, 4.3 * h), w("weekly_fable", 24, 160 * h)], { isActive: true }), // 93 / 4.3 = 21.6
    acc("blocked", [w("session", 0, 1 * h), w("weekly_fable", 100, 20 * h)]), // weekly used up: not usable
    acc("expired", [w("session", 0, 1 * h)], { needsReauthorization: true }),
    acc("nodata", []),
  ];
  const ranked = rankAccounts(accounts, "session", now);
  check("5h ranking is by urgency: soon, mid, fresh, active; blocked/expired/no-data excluded", ids(ranked) === "soon,mid,fresh,active", ids(ranked));
  const p = propose(accounts, "session", now)!;
  check("the proposal lists three candidates in that order", p.candidates.length === 3 && ids(p.candidates.map((c) => c.account)) === "soon,mid,fresh", ids(p.candidates.map((c) => c.account)));
  check("the best candidate is the proposal's account", p.account.id === "soon" && p.available === 40 && p.candidates[0].urgency > 40);
  check("the first reason says why it is urgent", p.candidates[0].reason === "40% of its 5h limit is available, it resets in 59 min, so use that capacity now or lose it, and the most urgent of the 4 usable accounts.", p.candidates[0].reason);
  check("later candidates get a plain reason", p.candidates[1].reason === "70% of its 5h limit is available, and it resets in 3 h.", p.candidates[1].reason);
  check("the active account is marked as such when it is a candidate", propose([accounts[3]], "session", now)!.reason.startsWith("It is already the active account: 93% of its 5h limit is available"));

  const fable = propose(accounts, "weekly_fable", now)!;
  check("Fable: usable accounts with a Fable limit, by urgency (mid 40%/50 h beats active 76%/160 h)", ids(fable.candidates.map((c) => c.account)) === "mid,active", ids(fable.candidates.map((c) => c.account)));
  check("ties on urgency fall back to the most available", ids(rankAccounts([acc("x", [w("session", 50, 2 * h)]), acc("y", [w("session", 20, 3.2 * h)])], "session", now)) === "y,x");

  check("nothing usable: no proposal", propose([acc("z", [w("session", 100, 30 * 60_000)])], "session", now) === null);
  check("reason when every account is used up names the wait", noProposalReason([acc("z", [w("session", 100, 30 * 60_000)])], "session", now) === "Every account is used up; the first is usable again in 30 min.");
  check("reason when no account has the limit", noProposalReason([acc("z", [w("session", 10)])], "weekly_fable", now) === "No account reports a Fable limit.");
  check("reason when only expired logins have it", noProposalReason([acc("z", [w("weekly_fable", 10)], { needsReauthorization: true })], "weekly_fable", now) === "Every account with a Fable limit has an expired login; reauthorize one first.");
}

function runToneTests(): void {
  console.log("usage colors:");
  const w = (kind: string, percent: number, label?: string) => ({ kind, label: label ?? kind, percent });
  const acc = (windows: ReturnType<typeof w>[], needsReauthorization = false) => ({ windows, needsReauthorization });
  check(
    "bar thresholds: 59 ok, 60 warn, 79 warn, 80 danger, 100 danger",
    [59, 60, 79, 80, 100].map((p) => toneOfPercent(p)).join() === "ok,warn,warn,danger,danger"
  );
  check("a custom threshold scales both steps", toneOfPercent(67, 90) === "ok" && toneOfPercent(68, 90) === "warn" && toneOfPercent(90, 90) === "danger");
  check(
    "the name is green while the 5h limit has room, even at 65% or 99%",
    nameTone(acc([w("session", 7)])) === "ok" && nameTone(acc([w("session", 65)])) === "ok" && nameTone(acc([w("session", 99)])) === "ok"
  );
  check("the name is red once the 5h limit is used up", nameTone(acc([w("session", 100)])) === "danger");
  check("other limits below 100% do not change it", nameTone(acc([w("session", 7), w("weekly_fable", 99)])) === "ok");
  check(
    "a used-up weekly limit makes the name red although 5h is free",
    nameTone(acc([w("session", 0), w("weekly_fable", 100, "Weekly (Fable)")])) === "danger"
  );
  check("the general weekly limit counts too", nameTone(acc([w("session", 10), w("weekly_all", 100)])) === "danger");
  check("without a 5h reading it is green until a limit is used up", nameTone(acc([w("weekly_all", 65)])) === "ok" && nameTone(acc([w("weekly_all", 100)])) === "danger");
  check("no usage data: no color", nameTone(acc([])) === undefined);
  check("an expired login gets no color", nameTone(acc([w("session", 100)], true)) === undefined);
  check(
    "the tooltip line explains the color",
    nameToneDescription(acc([w("session", 7)])) === "5h limit: 7% used" &&
      nameToneDescription(acc([w("session", 100)])) === "5h limit used up" &&
      nameToneDescription(acc([w("session", 0), w("weekly_fable", 100, "Weekly (Fable)")])) === "Weekly (Fable) used up: sessions are blocked too" &&
      nameToneDescription(acc([w("weekly_all", 30)])) === "Most used limit: 30%" &&
      nameToneDescription(acc([])) === undefined
  );
}

runProfileActivityTests();
runHistorySeriesTests();
runUtilizationTests();
runAvailabilityTests();
runListingTests();
runAvatarTests();
runToneTests();
runResetToneTests();
runProposeTests();
runBrowserOAuthTests();
runLimitResetTests();
runIdentityTests();
runAccountStoreTests()
  .then(runBackupTests)
  .then(runUsageHistoryTests)
  .then(runClaudeLockTests)
  .then(runCredentialSyncTests)
  .then(runRequestQueueTests)
  .then(runUsagePollerTests)
  .then(runSwitchServiceTests)
  .then(runTokenRefresherTests)
  .then(() => {
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
