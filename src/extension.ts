import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { AccountWindowService } from "./accountWindow";
import { BrowserOAuthLogin } from "./browserOAuth";
import {
  getConfiguredClaudeCommand,
  missingClaudeCliMessage,
  quoteForTerminal,
  resolveClaudeCommand,
} from "./cli";
import { CredentialSync, CurrentAccountState } from "./credentialSync";
import { hasUsableOAuthCreds, sameNonEmptyToken } from "./credentialValidation";
import { CredentialsManager } from "./credentials";
import {
  BackupError,
  BackupSettings,
  createBackupZip,
  MIN_BACKUP_PASSWORD_LENGTH,
  readBackupZip,
} from "./backup";
import { defaultProfileLabel, identityLabel, profileIdentity, sameIdentity } from "./identity";
import { getAccountConfigDir } from "./isolatedConfig";
import { LimitResetNotifier } from "./limitNotifier";
import { UsageHistory } from "./usageHistory";
import { TokenRefresher } from "./oauth";
import { ProfileActivityRegistry } from "./profileActivity";
import { SwitchService } from "./switchService";
import { AccountsViewProvider } from "./ui/accountsView";
import { AnalyticsPanel } from "./ui/analyticsPanel";
import { AvailabilityPanel } from "./ui/availabilityPanel";
import { StatusBarController } from "./ui/statusBar";
import { fetchUsage, MIN_POLL_INTERVAL_SECONDS, UsagePoller } from "./usage";
import { AccountProfile, ClaudeAuthIdentity, OAuthCreds, UsageSnapshot } from "./types";
import { WarmupService } from "./warmup";

const LOGIN_WATCH_TIMEOUT_MS = 15 * 60_000;
const CREDENTIALS_WATCH_INTERVAL_MS = 2_000;

export function activate(context: vscode.ExtensionContext): void {
  const store = new AccountStore(context);
  const credentials = new CredentialsManager();
  const refresher = new TokenRefresher();
  const browserOAuth = new BrowserOAuthLogin();
  const profileActivity = new ProfileActivityRegistry(context);
  const homeDir = (id: string) => getAccountConfigDir(context, id);
  const sync = new CredentialSync(store, credentials, refresher, homeDir);
  const switchService = new SwitchService(store, credentials, sync, (id) =>
    profileActivity.isActive(id, { excludeSelf: true })
  );
  const warmupService = new WarmupService(context, store, sync, profileActivity);
  const accountWindowService = new AccountWindowService(
    context,
    store,
    credentials,
    sync,
    profileActivity
  );
  const statusBar = new StatusBarController(store);
  const extensionVersion = String(context.extension.packageJSON.version ?? "");
  const viewProvider = new AccountsViewProvider(
    context.extensionUri,
    store,
    extensionVersion,
    context.globalState
  );

  const config = () => vscode.workspace.getConfiguration("tursoftClaudeSwitcher");
  const getInterval = () =>
    config().get<boolean>("autoRefresh", true) ? config().get<number>("pollIntervalSeconds", 240) : 0;

  // --- Limit reset notifications ---

  const limitNotifier = new LimitResetNotifier(
    ({ profileId, window }) => {
      if (!config().get<boolean>("notifyOnLimitReset", true)) {
        return;
      }
      const profile = store.get(profileId);
      if (!profile) {
        return;
      }
      const isActive = store.getActiveId() === profileId;
      const actions = isActive ? [] : ["Switch"];
      void vscode.window
        .showInformationMessage(
          `"${profile.label}": the ${window.label} limit is available again (${window.percent}% used).`,
          ...actions
        )
        .then((choice) => {
          if (choice === "Switch") {
            void vscode.commands.executeCommand("tursoftClaudeSwitcher.switchAccount", profileId);
          }
        });
    },
    (profileId) => void poller.pollOne(profileId, true).then(refreshUI)
  );

  const refreshUI = () => {
    statusBar.refresh();
    viewProvider.refresh();
    limitNotifier.schedule(store.list());
    AvailabilityPanel.notifyChanged();
  };

  // --- Current account tracking ---

  // Usage of an unsaved current login (it has no profile, so the poller never sees it).
  let currentUsageAt = 0;
  let currentUsageBackoffUntil = 0;
  let currentUsageBusy = false;
  const refreshCurrentUsage = async (unsaved: boolean, force = false) => {
    if (!unsaved) {
      currentUsageAt = 0;
      return;
    }
    const now = Date.now();
    const throttled = !force && now - currentUsageAt < MIN_POLL_INTERVAL_SECONDS * 1000;
    if (currentUsageBusy || now < currentUsageBackoffUntil || throttled) {
      return;
    }
    const creds = credentials.readCurrent();
    if (!creds) {
      return;
    }
    currentUsageBusy = true;
    viewProvider.setSessionBusy(true);
    try {
      const result = await fetchUsage(creds);
      currentUsageAt = Date.now();
      if (result.retryAfter) {
        currentUsageBackoffUntil = result.retryAfter;
      }
      viewProvider.setCurrentUsage(result.snapshot?.windows);
    } finally {
      currentUsageBusy = false;
      viewProvider.setSessionBusy(false);
    }
  };

  let currentUnsaved = false;
  let lastCurrentState: CurrentAccountState | undefined;
  const currentUsageTimer = setInterval(
    () => {
      if (getInterval() > 0) {
        void refreshCurrentUsage(currentUnsaved);
      }
    },
    MIN_POLL_INTERVAL_SECONDS * 1000
  );
  context.subscriptions.push({ dispose: () => clearInterval(currentUsageTimer) });

  let notifiedUnsavedKey: string | undefined;
  const applyCurrentState = (state: CurrentAccountState) => {
    profileActivity.setActiveProfile(store.getActiveId());
    statusBar.setUnsavedIdentity(state.unsavedIdentity);
    viewProvider.setCurrentSession(state);
    lastCurrentState = state;
    currentUnsaved = Boolean(state.loggedIn && !state.ownerId);
    void refreshCurrentUsage(currentUnsaved);
    const key = state.unsavedIdentity ? identityLabel(state.unsavedIdentity) : undefined;
    if (key && key !== notifiedUnsavedKey) {
      notifiedUnsavedKey = key;
      void vscode.window
        .showInformationMessage(
          `Claude Code is logged in as ${key}, which is not saved as a profile yet.`,
          "Save as profile"
        )
        .then((choice) => {
          if (choice === "Save as profile") {
            void vscode.commands.executeCommand("tursoftClaudeSwitcher.addCurrentAccount");
          }
        });
    }
    if (!key) {
      notifiedUnsavedKey = undefined;
    }
  };

  const synchronizeCurrentProfile = async (options: { retryFailed?: boolean } = {}) => {
    try {
      applyCurrentState(await sync.syncCurrent(options));
    } catch {
      profileActivity.setActiveProfile(store.getActiveId());
    }
  };

  // Claude Code rewrites its credentials file on every token rotation and on
  // /login. Import each new generation right away instead of waiting for the next
  // usage poll, so the saved profile never keeps an already spent refresh token.
  let watchedCredentialsPath: string | undefined;
  let syncTimer: NodeJS.Timeout | undefined;
  const onCredentialsFileChanged = () => {
    if (syncTimer) {
      clearTimeout(syncTimer);
    }
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void synchronizeCurrentProfile().then(refreshUI);
    }, 750);
  };
  const watchCredentialsFile = () => {
    const next = credentials.getCredentialsPath();
    if (watchedCredentialsPath === next) {
      return;
    }
    if (watchedCredentialsPath) {
      fs.unwatchFile(watchedCredentialsPath, onCredentialsFileChanged);
    }
    watchedCredentialsPath = next;
    fs.watchFile(next, { interval: CREDENTIALS_WATCH_INTERVAL_MS }, onCredentialsFileChanged);
  };

  // --- Login helpers ---

  const authorizeInBrowser = async (configDir?: string) => {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Waiting for Claude authorization in your browser...",
        cancellable: false,
      },
      () => browserOAuth.authorize((url) => vscode.env.openExternal(vscode.Uri.parse(url)))
    );
    if (result.ok && result.creds) {
      credentials.writeCreds(result.creds, configDir, {
        organizationUuid: result.identity?.orgId ?? null,
      });
      sync.rememberIdentity(result.creds, result.identity);
    }
    return result;
  };

  const openClaudeLogin = async (options?: { configDir?: string; terminalName?: string }) => {
    const configuredCommand = getConfiguredClaudeCommand();
    const resolvedCommand = resolveClaudeCommand(configuredCommand);
    if (!resolvedCommand) {
      const result = await authorizeInBrowser(options?.configDir);
      if (!result.ok) {
        vscode.window.showWarningMessage(
          `${missingClaudeCliMessage()} Browser authorization also failed: ${result.error ?? "unknown error"}`
        );
      } else {
        vscode.window.showInformationMessage(
          "Claude authorization completed in the browser without the Claude Code CLI."
        );
      }
      return { ok: result.ok, usedBrowser: true, identity: result.identity };
    }

    const terminal = vscode.window.createTerminal({
      name: options?.terminalName ?? "Claude Login",
      env: options?.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : undefined,
    });
    terminal.show();
    terminal.sendText(`${quoteForTerminal(resolvedCommand)} auth login`);
    return { ok: true, usedBrowser: false, identity: undefined as ClaudeAuthIdentity | undefined };
  };

  /**
   * Resolves once an isolated login wrote new usable credentials into `configDir`
   * (or after a timeout), so the user does not have to click "Complete" manually.
   */
  const pendingLoginWatches = new Set<() => void>();
  const waitForLogin = (configDir: string, previous: OAuthCreds | null) =>
    new Promise<boolean>((resolve) => {
      const file = credentials.getCredentialsPath(configDir);
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        fs.unwatchFile(file, check);
        clearTimeout(timeout);
        pendingLoginWatches.delete(cancel);
        resolve(value);
      };
      const cancel = () => finish(false);
      const check = () => {
        const creds = credentials.readCurrent(configDir);
        if (
          creds &&
          hasUsableOAuthCreds(creds) &&
          !(previous && sameNonEmptyToken(previous.refreshToken, creds.refreshToken))
        ) {
          finish(true);
        }
      };
      const timeout = setTimeout(cancel, LOGIN_WATCH_TIMEOUT_MS);
      pendingLoginWatches.add(cancel);
      fs.watchFile(file, { interval: 1_000 }, check);
      check();
    });

  // --- Isolated reauthorization of a saved profile ---

  const completeProfileReauthorization = async (
    id: string,
    silentWhenMissing = false
  ): Promise<{ ok: boolean; message: string; missing?: boolean }> => {
    const profile = store.get(id);
    if (!profile) {
      return { ok: false, message: "Profile not found." };
    }

    const configDir = homeDir(id);
    const creds = credentials.readCurrent(configDir);
    if (!creds || !hasUsableOAuthCreds(creds)) {
      return {
        ok: false,
        missing: silentWhenMissing,
        message: `No completed isolated login found for "${profile.label}" yet.`,
      };
    }

    const identity = await sync.identify(creds, configDir);
    if (!identity) {
      return {
        ok: false,
        message: `Could not verify which Claude account the isolated login for "${profile.label}" belongs to.`,
      };
    }

    const conflict = store.findByIdentity(identity, id);
    if (conflict) {
      return {
        ok: false,
        message:
          `The isolated login belongs to "${conflict.label}" (${identityLabel(identity)}). ` +
          `"${profile.label}" was not overwritten.`,
      };
    }

    const previousIdentity = profileIdentity(profile);
    if (previousIdentity && !sameIdentity(previousIdentity, identity)) {
      return {
        ok: false,
        message:
          `The isolated login identity (${identityLabel(identity)}) does not match ` +
          `"${profile.label}" (${identityLabel(previousIdentity)}). The profile was not overwritten.`,
      };
    }

    await store.updateCreds(id, creds);
    await store.updateIdentity(id, identity);
    await store.clearUsageError(id);
    await sync.captureOAuthAccount(id, configDir);
    return {
      ok: true,
      message: `Reauthorized "${profile.label}" as ${identityLabel(identity)}.`,
    };
  };

  const startProfileReauthorization = async (id: string) => {
    const profile = store.get(id);
    if (!profile) {
      vscode.window.showWarningMessage("Profile not found.");
      return;
    }

    const configDir = homeDir(id);
    try {
      credentials.moveCredentialsAside(configDir, "reauth-backup");
    } catch (e) {
      vscode.window.showWarningMessage((e as Error).message);
      return;
    }

    const login = await openClaudeLogin({
      configDir,
      terminalName: `Claude Login: ${profile.label}`,
    });
    if (!login.ok) {
      return;
    }

    const finish = async () => {
      const res = await completeProfileReauthorization(id);
      vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      if (res.ok) {
        await poller.pollOne(id, true);
      }
      refreshUI();
    };

    if (login.usedBrowser || (await waitForLogin(configDir, null))) {
      await finish();
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `The isolated login for "${profile.label}" was not detected. Complete it manually once you finished logging in.`,
      "Complete reauthorization"
    );
    if (choice === "Complete reauthorization") {
      await finish();
    }
  };

  // --- Adding another account without touching the current one ---

  const importIsolatedLogin = async (id: string, configDir: string) => {
    const creds = credentials.readCurrent(configDir);
    if (!creds || !hasUsableOAuthCreds(creds)) {
      vscode.window.showWarningMessage("No completed Claude login was found.");
      return;
    }
    const identity = await sync.identify(creds, configDir);
    const existing = identity ? store.findByIdentity(identity) : undefined;
    if (existing) {
      await store.updateCreds(existing.id, creds);
      if (identity) {
        await store.updateIdentity(existing.id, identity);
      }
      await store.clearUsageError(existing.id);
      await sync.captureOAuthAccount(existing.id, configDir);
      fs.rmSync(configDir, { recursive: true, force: true });
      vscode.window.showInformationMessage(
        `This login belongs to the saved profile "${existing.label}"; it was refreshed with the new login.`
      );
      await poller.pollOne(existing.id, true);
      refreshUI();
      return;
    }

    const profile = await store.addFromCreds(defaultProfileLabel(identity, creds), creds, {
      id,
      identity,
      activate: false,
    });
    await sync.captureOAuthAccount(profile.id, configDir);
    offerRename(
      profile.id,
      `Saved "${profile.label}". The current Claude Code account was not changed; use Switch when you need it.`
    );
    await poller.pollOne(profile.id, true);
    refreshUI();
  };

  /** Confirms a newly saved profile (named after its email) with a shortcut to rename it. */
  const offerRename = (id: string, message: string) => {
    void vscode.window.showInformationMessage(message, "Rename").then((choice) => {
      if (choice === "Rename") {
        void vscode.commands.executeCommand("tursoftClaudeSwitcher.renameAccount", id);
      }
    });
  };

  const addAccount = async () => {
    const id = crypto.randomUUID();
    const configDir = homeDir(id);
    fs.mkdirSync(configDir, { recursive: true });
    const login = await openClaudeLogin({ configDir, terminalName: "Claude Login: new account" });
    if (!login.ok) {
      fs.rmSync(configDir, { recursive: true, force: true });
      return;
    }
    if (!login.usedBrowser) {
      vscode.window.showInformationMessage(
        "Finish the login in the terminal/browser. The current Claude Code account stays untouched; the new account is saved automatically."
      );
      if (!(await waitForLogin(configDir, null))) {
        fs.rmSync(configDir, { recursive: true, force: true });
        vscode.window.showWarningMessage("No completed Claude login was detected. Nothing was saved.");
        return;
      }
    }
    await importIsolatedLogin(id, configDir);
  };

  const poller = new UsagePoller(
    store,
    sync,
    getInterval,
    refreshUI,
    (id, previous, next) => {
      limitNotifier.onSnapshot(id, previous, next);
      if (historyEnabled()) {
        const profile = store.get(id);
        void history
          .record(id, next, { label: profile?.label, plan: profile?.subscriptionType })
          .then((written) => written && AnalyticsPanel.notifyNewData());
      }
    },
    applyCurrentState
  );
  poller.onBusyChange = (ids, all) => viewProvider.setBusy(ids, all);

  // Publish the remembered owner before asynchronous startup work, so another
  // window does not start a second session on this login during restart.
  profileActivity.setActiveProfile(store.getActiveId());

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AccountsViewProvider.viewType, viewProvider),
    statusBar,
    profileActivity,
    { dispose: () => poller.stop() },
    limitNotifier,
    {
      dispose: () => {
        if (watchedCredentialsPath) {
          fs.unwatchFile(watchedCredentialsPath, onCredentialsFileChanged);
        }
        if (syncTimer) {
          clearTimeout(syncTimer);
        }
        for (const cancel of [...pendingLoginWatches]) {
          cancel();
        }
      },
    }
  );

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.addCurrentAccount", async () => {
      const res = await switchService.captureCurrent();
      if (res.createdId) {
        offerRename(res.createdId, res.message);
      } else {
        vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      }
      await synchronizeCurrentProfile();
      const activeId = store.getActiveId();
      if (res.ok && activeId) {
        await poller.pollOne(activeId, true);
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.addAccount", () => addAccount())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.switchAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Switch to account…"));
      if (!targetId) {
        return;
      }
      // Picking from the list is already a deliberate choice; a single click on a
      // Switch button (panel, notification) asks first.
      if (id && !(await confirmSwitch(targetId))) {
        return;
      }
      let res = await switchService.switchTo(targetId);
      if (!res.ok && res.reauthProfileId) {
        const completed = await completeProfileReauthorization(res.reauthProfileId, true);
        if (completed.ok) {
          res = await switchService.switchTo(targetId);
        } else if (!completed.missing) {
          vscode.window.showWarningMessage(completed.message);
        }
      }
      if (!res.ok) {
        if (res.reauthProfileId) {
          const choice = await vscode.window.showWarningMessage(
            `${res.message} Reauthorize this profile in an isolated Claude login so another saved account cannot overwrite it.`,
            "Reauthorize profile"
          );
          if (choice === "Reauthorize profile") {
            await startProfileReauthorization(res.reauthProfileId);
          }
        } else if (res.message !== "Cancelled.") {
          vscode.window.showWarningMessage(res.message);
        }
      }
      profileActivity.setActiveProfile(store.getActiveId());
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.refreshUsage", async (id?: string) => {
      if (id) {
        await poller.pollOne(id, true);
        refreshUI();
      } else {
        await poller.pollAll(true);
      }
    })
  );

  /** "5h 30% · 7d 12% · Fable 4%" for a usage snapshot. */
  const usageSummary = (snapshot: UsageSnapshot | undefined): string => {
    const windows = snapshot?.windows ?? [];
    if (windows.length === 0) {
      return "usage unknown";
    }
    return windows
      .map((w) => {
        const scope = /^Weekly \((.+)\)$/.exec(w.label)?.[1];
        const short = w.kind === "session" ? "5h" : scope && scope !== "all" ? scope : "7d";
        return `${short} ${w.percent}%`;
      })
      .join(" · ");
  };

  const describeProfile = (profileId: string): string => {
    const p = store.get(profileId);
    if (!p) {
      return "Unknown account";
    }
    const plan = p.subscriptionType ? ` (${p.subscriptionType})` : "";
    return `${p.label}${plan} — ${usageSummary(p.lastUsage)}`;
  };

  /** Asks before switching, naming the current and the target account. */
  const confirmSwitch = async (targetId: string): Promise<boolean> => {
    const activeId = store.getActiveId();
    let from: string;
    let note = "";
    if (lastCurrentState?.loggedIn === false) {
      from = "No account logged in";
    } else if (lastCurrentState?.unsavedIdentity || (lastCurrentState?.loggedIn && !activeId)) {
      const who = lastCurrentState?.unsavedIdentity ? identityLabel(lastCurrentState.unsavedIdentity) : "Unknown account";
      from = `${who} (not saved)`;
      note =
        "\n\nThe current login is not in your account list. Save it first if you want to switch back to it later.";
    } else if (activeId) {
      from = describeProfile(activeId);
    } else {
      from = "Unknown account";
    }
    const choice = await vscode.window.showInformationMessage(
      `Switch Claude Code to "${store.get(targetId)?.label ?? targetId}"?`,
      { modal: true, detail: `From:  ${from}\nTo:      ${describeProfile(targetId)}${note}` },
      "Switch"
    );
    return choice === "Switch";
  };

  // Reloads everything the panel shows: the detected login, the account list, and
  // the limits of every account and of an unsaved current login.
  let refreshingAll: Promise<void> | undefined;
  const refreshAll = () => {
    refreshingAll ??= Promise.resolve(
      vscode.window.withProgress({ location: { viewId: AccountsViewProvider.viewType } }, async () => {
        // Check the login Claude Code (CLI or extension) uses now, retrying a failed
        // account lookup; polling then records identities of older profiles, so
        // check once more before showing the result.
        await synchronizeCurrentProfile({ retryFailed: true });
        await poller.pollAll(true);
        await synchronizeCurrentProfile({ retryFailed: true });
        await refreshCurrentUsage(currentUnsaved, true);
        refreshUI();
      })
    ).finally(() => {
      refreshingAll = undefined;
    });
    return refreshingAll;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.refreshAll", refreshAll)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.sayHi", async (id?: string) => {
      const targetIds = id ? [id] : await pickWarmupTargets(store);
      if (!targetIds || targetIds.length === 0) {
        return;
      }

      for (const targetId of targetIds) {
        const res = await warmupService.sayHi(targetId);
        vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
        if (res.ok) {
          await poller.pollOne(targetId, true);
        }
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.openIndependentWindow", async (id?: string) => {
      const targetIds = id ? [id] : await pickWindowTargets(store);
      if (!targetIds || targetIds.length === 0) {
        return;
      }

      for (const targetId of targetIds) {
        const res = await accountWindowService.open(targetId);
        vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.login", async () => {
      // Save the outgoing login's latest rotation before Claude Code replaces it.
      await synchronizeCurrentProfile();
      await openClaudeLogin();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.browserLogin", async () => {
      await synchronizeCurrentProfile();
      const result = await authorizeInBrowser();
      if (result.ok) {
        vscode.window.showInformationMessage(
          "Claude authorization completed in the browser. Reload the window so Claude Code uses it."
        );
        await synchronizeCurrentProfile();
      } else {
        vscode.window.showWarningMessage(
          `Browser authorization failed: ${result.error ?? "unknown error"}`
        );
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.reauthorizeProfile", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Reauthorize profile..."));
      if (targetId) {
        await startProfileReauthorization(targetId);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tursoftClaudeSwitcher.completeProfileReauthorization",
      async (id?: string) => {
        const targetId = id ?? (await pickAccount(store, "Complete profile reauthorization..."));
        if (!targetId) {
          return;
        }
        const res = await completeProfileReauthorization(targetId);
        vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
        if (res.ok) {
          await poller.pollOne(targetId, true);
        }
        refreshUI();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.removeAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Remove account profile…"));
      if (!targetId) {
        return;
      }
      const profile = store.get(targetId);
      const confirm = await vscode.window.showWarningMessage(
        `Remove the profile "${profile?.label ?? targetId}"? (does not log the account out of Claude)`,
        { modal: true },
        "Remove"
      );
      if (confirm === "Remove") {
        await store.remove(targetId);
        // The removed profile may have been the current login: detect it again so
        // the panel offers it as an unsaved session.
        await synchronizeCurrentProfile();
        refreshUI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.renameAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Rename profile…"));
      if (!targetId) {
        return;
      }
      const profile = store.get(targetId);
      const label = await vscode.window.showInputBox({
        title: "New profile name",
        value: profile?.label,
        validateInput: (v) => (v.trim().length === 0 ? "Enter a name" : undefined),
      });
      if (label) {
        await store.rename(targetId, label.trim());
        refreshUI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.undoSwitch", async () => {
      const res = await switchService.undoSwitch();
      profileActivity.setActiveProfile(store.getActiveId());
      vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      refreshUI();
    })
  );

  // --- Usage history ---

  const history = new UsageHistory(path.join(context.globalStorageUri.fsPath, "usage-history"));
  const historyEnabled = () => config().get<boolean>("usageHistory.enabled", false);
  let historyTimer: NodeJS.Timeout | undefined;
  let historyPruneTimer: NodeJS.Timeout | undefined;

  /** While collection is on, reads every account's usage once per configured period. */
  const restartHistoryCollection = () => {
    clearInterval(historyTimer);
    clearInterval(historyPruneTimer);
    historyTimer = historyPruneTimer = undefined;
    if (!historyEnabled()) {
      return;
    }
    const seconds = Math.max(MIN_POLL_INTERVAL_SECONDS, config().get<number>("usageHistory.intervalSeconds", 60));
    historyTimer = setInterval(() => void poller.pollAll(false), seconds * 1000);
    const prune = () => void history.prune(config().get<number>("usageHistory.retentionDays", 90));
    prune();
    historyPruneTimer = setInterval(prune, 86_400_000);
  };
  context.subscriptions.push({
    dispose: () => {
      clearInterval(historyTimer);
      clearInterval(historyPruneTimer);
    },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.openAnalytics", () =>
      AnalyticsPanel.show(context.extensionUri, { store, history, getConfig: config })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.openAvailability", () =>
      AvailabilityPanel.show(context.extensionUri, { store, history, getConfig: config })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.clearUsageHistory", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "Delete all collected usage history? Charts and the availability calendar lose their past data.",
        { modal: true },
        "Delete history"
      );
      if (confirm === "Delete history") {
        await history.clear();
        vscode.window.showInformationMessage("Usage history deleted.");
      }
    })
  );

  // --- Backup / restore ---

  // Machine-specific settings stay out of backups.
  const LOCAL_ONLY_SETTINGS = new Set(["credentialsPath"]);
  const settingKeys = (): string[] =>
    Object.keys(context.extension.packageJSON.contributes?.configuration?.properties ?? {})
      .filter((k) => k.startsWith("tursoftClaudeSwitcher."))
      .map((k) => k.slice("tursoftClaudeSwitcher.".length))
      .filter((k) => !LOCAL_ONLY_SETTINGS.has(k));

  /** Panel choices plus the user's own (global) extension settings. */
  const collectBackupSettings = (): BackupSettings => {
    const values: Record<string, unknown> = {};
    for (const key of settingKeys()) {
      const value = config().inspect(key)?.globalValue;
      if (value !== undefined) {
        values[key] = value;
      }
    }
    return { view: viewProvider.getViewSettings(), config: values };
  };

  const restoreBackupSettings = async (settings: BackupSettings | undefined) => {
    if (settings?.view) {
      await viewProvider.applyViewSettings(settings.view);
    }
    const known = new Set(settingKeys());
    for (const [key, value] of Object.entries(settings?.config ?? {})) {
      if (known.has(key)) {
        await config().update(key, value, vscode.ConfigurationTarget.Global);
      }
    }
  };

  const askBackupPassword = async (confirm: boolean): Promise<string | undefined> => {
    const password = await vscode.window.showInputBox({
      title: confirm ? "Back up accounts: choose a password" : "Restore accounts: backup password",
      prompt: confirm
        ? "The backup contains login tokens. Anyone with the file and this password can use your accounts."
        : "Password used when the backup was created",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) =>
        confirm && v.length < MIN_BACKUP_PASSWORD_LENGTH
          ? `Use at least ${MIN_BACKUP_PASSWORD_LENGTH} characters`
          : v.length === 0
            ? "Enter the password"
            : undefined,
    });
    if (!password || !confirm) {
      return password;
    }
    const again = await vscode.window.showInputBox({
      title: "Back up accounts: confirm password",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v === password ? undefined : "Passwords do not match"),
    });
    return again === password ? password : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.backupAccounts", async () => {
      if (store.list().length === 0) {
        vscode.window.showInformationMessage("There are no saved accounts to back up.");
        return;
      }
      // Pull the newest token rotation of the current login into the vault first.
      await synchronizeCurrentProfile();
      const password = await askBackupPassword(true);
      if (!password) {
        return;
      }
      // Local time, e.g. 20261029-105903, so several backups a day do not collide.
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
        `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const target = await vscode.window.showSaveDialog({
        title: "Save account backup",
        defaultUri: vscode.Uri.joinPath(
          vscode.Uri.file(os.homedir()),
          `claude-accounts-${stamp}.zip`
        ),
        filters: { "ZIP archive": ["zip"] },
      });
      if (!target) {
        return;
      }
      try {
        const entries = await store.exportAll();
        const zip = await createBackupZip(entries, password, extensionVersion, collectBackupSettings());
        await vscode.workspace.fs.writeFile(target, zip);
        vscode.window.showInformationMessage(
          `Backed up ${entries.length} account(s) to ${target.fsPath}. Keep the file and its password safe.`
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Backup failed: ${(e as Error).message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.restoreAccounts", async () => {
      const picked = await vscode.window.showOpenDialog({
        title: "Restore account backup",
        canSelectMany: false,
        filters: { "ZIP archive": ["zip"] },
      });
      if (!picked?.[0]) {
        return;
      }
      let data: Uint8Array;
      try {
        data = await vscode.workspace.fs.readFile(picked[0]);
      } catch (e) {
        vscode.window.showErrorMessage(`Could not read the backup: ${(e as Error).message}`);
        return;
      }

      for (;;) {
        const password = await askBackupPassword(false);
        if (!password) {
          return;
        }
        try {
          const { accounts: entries, settings } = await readBackupZip(data, password);
          const res = await store.restore(entries);
          await restoreBackupSettings(settings);
          await synchronizeCurrentProfile();
          vscode.window.showInformationMessage(
            `Restore finished: ${res.added} added, ${res.updated} updated with newer tokens, ` +
              `${res.unchanged} already up to date.`
          );
          refreshUI();
          void poller.pollAll(true);
          return;
        } catch (e) {
          const message = e instanceof BackupError ? e.message : `Restore failed: ${(e as Error).message}`;
          if (message === "Wrong password.") {
            const retry = await vscode.window.showWarningMessage("Wrong password.", "Try again");
            if (retry === "Try again") {
              continue;
            }
            return;
          }
          vscode.window.showErrorMessage(message);
          return;
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.about", async () => {
      await vscode.commands.executeCommand("tursoftClaudeSwitcher.accountsView.focus");
      viewProvider.showAbout();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tursoftClaudeSwitcher.openPanel", () => {
      void vscode.commands.executeCommand("tursoftClaudeSwitcher.accountsView.focus");
    })
  );

  // React to setting changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("tursoftClaudeSwitcher.pollIntervalSeconds") ||
        e.affectsConfiguration("tursoftClaudeSwitcher.autoRefresh")
      ) {
        poller.restart();
      }
      if (e.affectsConfiguration("tursoftClaudeSwitcher.usageHistory")) {
        restartHistoryCollection();
      }
      if (e.affectsConfiguration("tursoftClaudeSwitcher.warnThresholdPercent")) {
        refreshUI();
      }
      if (e.affectsConfiguration("tursoftClaudeSwitcher.credentialsPath")) {
        watchCredentialsFile();
        onCredentialsFileChanged();
      }
    })
  );

  // A login can also change while this window is in the background (another
  // window, a terminal `claude /login`); check again when the user comes back.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        onCredentialsFileChanged();
      }
    })
  );

  watchCredentialsFile();
  void synchronizeCurrentProfile().then(() => {
    refreshUI();
    poller.start();
    restartHistoryCollection();
  });
}

export function deactivate(): void {
  /* resources are released via context.subscriptions */
}

/** Shared account-picker QuickPick with a usage preview. */
async function pickAccount(store: AccountStore, title: string): Promise<string | undefined> {
  const activeId = store.getActiveId();
  const accounts = store.list();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No saved accounts. Use \"Save current account as profile\" first."
    );
    return undefined;
  }

  const items = accounts.map((p: AccountProfile) => {
    const u = p.lastUsage;
    const parts: string[] = [];
    if (typeof u?.sessionPercent === "number") parts.push(`5h: ${u.sessionPercent}%`);
    if (typeof u?.weeklyPercent === "number") parts.push(`weekly: ${u.weeklyPercent}%`);
    if (u?.error) parts.push("⚠ usage error");
    return {
      label: (p.id === activeId ? "$(check) " : "$(account) ") + p.label,
      description: [p.subscriptionType, parts.join("  ")].filter(Boolean).join("  ·  "),
      id: p.id,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Select an account",
    matchOnDescription: true,
  });
  return picked?.id;
}

async function pickWarmupTargets(store: AccountStore): Promise<string[] | undefined> {
  const accounts = store.list();
  const activeId = store.getActiveId();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No saved accounts. Use \"Save current account as profile\" first."
    );
    return undefined;
  }

  const inactive = accounts.filter((p) => p.id !== activeId);
  const items: Array<{ label: string; description?: string; ids: string[] }> = [];
  if (inactive.length > 1) {
    items.push({
      label: "$(run-all) Say Hi on all inactive accounts",
      description: `${inactive.length} accounts`,
      ids: inactive.map((p) => p.id),
    });
  }
  for (const p of accounts) {
    items.push({
      label: (p.id === activeId ? "$(circle-slash) " : "$(comment) ") + p.label,
      description:
        p.id === activeId
          ? "active account is skipped to avoid token races"
          : p.subscriptionType,
      ids: p.id === activeId ? [] : [p.id],
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Say Hi",
    placeHolder: "Select account to warm up",
    matchOnDescription: true,
  });
  return picked?.ids;
}

async function pickWindowTargets(store: AccountStore): Promise<string[] | undefined> {
  const accounts = store.list();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No saved accounts. Use \"Save current account as profile\" first."
    );
    return undefined;
  }

  const activeId = store.getActiveId();
  const items: Array<{ label: string; description?: string; ids: string[] }> = [];
  if (accounts.length > 1) {
    items.push({
      label: "$(run-all) Open all accounts in independent windows",
      description: `${accounts.length} windows`,
      ids: accounts.map((p) => p.id),
    });
  }
  for (const p of accounts) {
    items.push({
      label: (p.id === activeId ? "$(check) " : "$(window) ") + p.label,
      description: p.id === activeId ? "current account" : p.subscriptionType,
      ids: [p.id],
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Open independent account window",
    placeHolder: "Select account",
    matchOnDescription: true,
  });
  return picked?.ids;
}
