# Claude Multi-Account Switcher

Quickly switch between Claude accounts (subscriptions) in **Claude Code** inside VS Code,
with live usage limits for all your accounts at a glance.

> This project is a fork of
> [KrzysztofZander/claude-account-switcher](https://github.com/KrzysztofZander/claude-account-switcher)
> by Krzysztof Zander.

## Why

You have several Claude subscriptions. When one account runs out of usage (the 5-hour or
weekly window), switch Claude Code to another account with a single click — no manual logout
and re-login.

## Features

- **Save accounts** — click "Save current" to save the account Claude Code is logged in with,
  or "+ Add account" to log in to another account in an isolated login that does not touch the
  current one (tokens are kept in VS Code's encrypted secret storage).
- **Stays logged in** — the extension behaves like one more Claude Code process: it refreshes
  rotating OAuth tokens only under Claude Code's own refresh lock and writes every rotation back
  to all local copies, so neither Claude Code nor the extension is left with a spent token.
- **Fast switching** — from the panel, the status bar, or the command palette (QuickPick).
- **Live usage limits** — utilization (%) of the 5-hour and weekly windows for each account,
  with time until reset. Data comes from the same source as the `/usage` command.
- **Say Hi warmup** — run a one-turn `claude -p "Hi"` on inactive saved accounts using
  `--model haiku` by default, without switching the active `.credentials.json`.
- **Independent account windows** — open the same project in separate VS Code windows, each
  with its own Claude account and `CLAUDE_CONFIG_DIR`.
- **Browser authorization** — if Claude Code CLI is unavailable, complete OAuth login in the
  default browser; a dedicated command is available even when the CLI is installed.
- **Login helper** — prefers an integrated terminal with `claude auth login` when the CLI is
  available, then falls back to browser authorization. Completed logins are detected
  automatically.
- **Isolated reauthorization** — if a saved profile's credentials break, re-login happens in
  that profile's own `CLAUDE_CONFIG_DIR` instead of copying the currently active account.
- **Status bar** — the active account and its usage % always in view.
- **Compact panel** — one row per account with usage bars, reset times, and a **⋯** menu for
  all actions. **Switch** and **Refresh** buttons sit next to it inside each account's box, with
  the time of the last update under the account's icon, which is green while the account has limit
  left, orange once a limit is used up, and gray when usage is unknown or the login expired. The
  account's name is green while its 5h limit has room and red once the 5h limit or a weekly limit
  is used up (Claude then refuses sessions too). The reset time next
  to a bar stays gray, except for a limit that is used up: yellow under 10 minutes, orange under
  an hour, red beyond a day. Drag
  and drop to reorder; the order is
  remembered. Double-click an account's name to copy it (also in the availability calendar).
- **Filters** — free-text filter plus **All / Available / Limited** to show only accounts with
  usage left (or used up), plus filters by plan (Pro, Max, Team, ...) and by model-specific
  limits (e.g. only accounts with, or without, a Fable limit); one click clears the filters.
- **Sorting** — keep your own drag-and-drop order, or sort by availability (usable accounts
  first, then the ones that free up soonest), usage left, next reset, plan, or name.
- **Current session hint** — if Claude Code is logged in with an account that is not saved yet,
  it is shown at the bottom of the list with **Save to account list**; if nothing is logged in,
  the panel says so. New accounts are named after their email and can be renamed later.
- **Limit reset notifications** — get notified when a used-up session, weekly, or
  model-specific weekly limit becomes available again, with a one-click **Switch**.
- **Backup / restore** — export the account list (including tokens) to an AES-256
  password-protected ZIP and restore it later or on another machine.

## Requirements

- Claude Code CLI is optional for browser authorization, account switching, and usage checks.
  It is still required for **Say Hi**, CLI-based identity checks, and using Claude Code itself.
- For CLI-only features, the `claude` command must be available in VS Code's PATH, or
  `tursoftClaudeSwitcher.claudeCommand` must point to the full path of `claude`, `claude.exe`, or
  `claude.cmd`.
- On Windows PowerShell, Claude Code CLI can be installed with:

```powershell
irm https://claude.ai/install.ps1 | iex
```

## How it works

- Claude Code credentials live in `~/.claude/.credentials.json`. Switching accounts swaps the
  contents of that file (a `.bak` backup is kept so you can undo) and the cached `oauthAccount`
  in `~/.claude.json`, so Claude Code shows the right account.
- **After switching you must reload the VS Code window** so Claude Code picks up the new
  account — the extension offers to do it automatically (auto-reload can be enabled in settings).
- Saved inactive accounts are warmed up through an isolated `CLAUDE_CONFIG_DIR` under the
  extension's global storage. This lets "Say Hi" refresh/use that account without changing the
  currently active Claude Code account.
- Independent windows use generated `.code-workspace` files under the extension's global storage.
  Each window points Claude Code at the selected account's isolated config directory.
- Usage is read from the unofficial `api.anthropic.com/api/oauth/usage` endpoint (the same
  source as `/usage`). It is **heavily rate-limited**, so refreshing is capped to a safe interval
  (240s by default, minimum 180s) plus a manual ⟳ refresh.

### Token handling (why you no longer need to re-authorize daily)

Claude Code's OAuth refresh tokens are **single-use**: every refresh returns a new refresh token
and invalidates the old one. When two programs hold copies of the same login and one of them
refreshes without telling the other, the other one gets `invalid_grant` and asks you to log in
again. This extension therefore:

1. **Uses Claude Code's own refresh lock.** Before spending a refresh token it takes the same
   locks Claude Code uses (`<configDir>/.oauth_refresh.lock` and `<configDir>.lock`) in every
   config directory holding that login. Claude Code waits for the lock, then re-reads the file
   and adopts the new tokens instead of spending the old ones.
2. **Writes every rotation back** (compare-and-swap) to each local credentials file that still
   holds the spent token, and to the saved profile.
3. **Always uses the newest generation** across the saved profile, `~/.claude` and the
   profile's isolated config directory, and refreshes only when the access token is expiring.
4. **Watches `.credentials.json`** and imports Claude Code's own rotations immediately, and
   identifies the logged-in account by its account id (via `/api/oauth/profile`), so a profile
   is recognized even after both of its tokens rotated.
5. **Saves the outgoing account first when switching**, under the lock, so the account you
   switch away from keeps its latest tokens.
6. **Never retries a refresh token the server rejected**, and recovers automatically as soon as
   any copy contains a newer valid login.

### Do not use `/logout` to change accounts

`/logout` (and `claude auth logout`) **revokes the refresh token on Anthropic's side**. If that
login was saved as a profile, the saved copy dies with it and must be reauthorized. To change
accounts use **Switch**, to add one use **+ Add account**, or run `/login` directly — `/login`
does not revoke the previous login.

Each `claude auth login` creates an independent login, so logging in on another computer does
not affect this one. Profiles are stored per machine (VS Code SecretStorage is not synced); add
the account on each computer separately instead of copying credential files between machines.

## Usage

1. Log in to Claude Code with account #1.
2. Open the **MultiAccount** panel (activity bar icon) → **"Save current"**.
3. Click **"+ Add account"** and log in with account #2. The current Claude Code account is not
   changed; the new account is saved automatically when the login completes.
4. From now on, switch with one click via the switch icon on an account row (shown on hover), the
   row's **⋯** menu, the status bar, or `Claude: Switch account`. After confirmation the window
   reloads and Claude Code runs on the selected account.
5. Drag rows to reorder accounts (or use **Move up / Move down** in the **⋯** menu). The order is
   remembered and also used by the status bar QuickPick.

## Commands

| Command | Description |
| --- | --- |
| `Claude: Save current account as profile` | saves the currently logged-in account |
| `Claude: Add another account (isolated login)` | logs in to another account without touching the current one and saves it |
| `Claude: Switch account` | QuickPick with usage limits |
| `Claude: Refresh usage limits` | forces a refresh |
| `Claude: Say Hi on account` | warms up inactive saved accounts via `claude -p` |
| `Claude: Open independent account window` | opens this project in a new VS Code window scoped to one account |
| `Claude: Log in from terminal (replaces the current account)` | opens `claude auth login` for the current config dir, or falls back to browser authorization when CLI is unavailable |
| `Claude: Authorize in browser (without CLI)` | completes OAuth authorization in the default browser |
| `Claude: Reauthorize account profile` | opens isolated login for a saved profile without touching the active account |
| `Claude: Complete profile reauthorization` | imports the completed isolated login into that same profile |
| `Claude: Undo last switch` | restores the previous account from `.bak` |
| `Claude: Remove / Rename account profile` | manage profiles |
| `Claude: Back up account list (password-protected ZIP)` | saves all profiles and their tokens to an encrypted ZIP |
| `Claude: Restore account list from backup` | merges a backup into the list (never replaces newer tokens) |
| `Claude: About Tursoft Claude Multi-Account Switcher` | shows version, author, and fork information |
| `Claude: Show usage analytics` | charts the collected usage history |
| `Claude: Show account availability calendar` | week/day timeline of when each account and limit is usable |
| `Claude: Delete collected usage history` | removes all recorded usage readings |

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `tursoftClaudeSwitcher.autoRefresh` | `true` | regularly check usage limits of all accounts |
| `tursoftClaudeSwitcher.pollIntervalSeconds` | `240` | check interval in seconds (min 60; short intervals with many accounts can hit HTTP 429) |
| `tursoftClaudeSwitcher.notifyOnLimitReset` | `true` | notify when a used-up limit becomes available again |
| `tursoftClaudeSwitcher.autoReloadAfterSwitch` | `false` | auto-reload the window after switching |
| `tursoftClaudeSwitcher.credentialsPath` | `""` | override the path to `.credentials.json` |
| `tursoftClaudeSwitcher.warnThresholdPercent` | `80` | warning threshold (%): usage bars and the status bar turn red from it and orange from 75% of it |
| `tursoftClaudeSwitcher.claudeCommand` | `claude` | CLI command used for CLI login and Say Hi; set the full path if VS Code cannot find it |
| `tursoftClaudeSwitcher.sayHiModel` | `haiku` | model alias passed to `claude -p` |
| `tursoftClaudeSwitcher.sayHiPrompt` | `Hi` | prompt used by Say Hi |
| `tursoftClaudeSwitcher.sayHiTimeoutSeconds` | `120` | Say Hi timeout |

## Troubleshooting Say Hi

If Say Hi reports that `claude` is not recognized, the VS Code extension process cannot find the
Claude Code CLI. Try these in order:

1. Run `where claude` in PowerShell or CMD.
2. If it is found, restart VS Code so the extension host gets the refreshed PATH.
3. If it is not found, install Claude Code CLI. On Windows PowerShell, the official installer is:

```powershell
irm https://claude.ai/install.ps1 | iex
```

4. If the command exists but VS Code still cannot see it, set `tursoftClaudeSwitcher.claudeCommand` to the
   full path, for example `C:\Users\you\AppData\Roaming\npm\claude.cmd` or the path returned by
   `where claude`.

## Parallel VS Code windows

Use **Claude: Open independent account window** or the **Window** button on an account card.
The extension writes the saved account credentials to a per-account config directory, generates a
`.code-workspace` file for the current folder/workspace, and opens it in a new VS Code window.

The default Claude Code login file is global, so two regular VS Code windows share the same active
account. Independent windows avoid that by setting both:

```json
{
  "claudeCode.environmentVariables": [
    {
      "name": "CLAUDE_CONFIG_DIR",
      "value": "C:\\Users\\you\\.claude-user2"
    }
  ],
  "tursoftClaudeSwitcher.credentialsPath": "C:\\Users\\you\\.claude-user2\\.credentials.json"
}
```

Open one generated window per account you want to run. The extension refuses to open a second
active window for the same saved profile: two Claude Code sessions in different config
directories would each try to spend the same single-use refresh token.

## Security and disclaimers

- This extension does **not** collect telemetry, analytics, account identifiers, prompts,
  credentials, tokens, usage data, or any other personal data.
- No login data is sent to the extension author, publisher, marketplace backend, or any custom
  third-party server controlled by this extension.
- Saved profile secrets are stored in VS Code's encrypted **SecretStorage**.
- Claude Code itself requires local `.credentials.json` files. For account switching, Say Hi,
  and independent windows, the extension writes credentials only to local Claude Code config
  directories on your machine, including isolated per-account `CLAUDE_CONFIG_DIR` folders under
  the extension's global storage.
- Credentials are never intentionally logged. Protect your machine and OS user account, because
  anyone with local filesystem access to your user profile may be able to read Claude Code
  credential files.
- Network requests made by the extension go only to Anthropic endpoints needed for token refresh,
  usage-limit checks, and identifying which account a login belongs to (`/api/oauth/profile`,
  the same endpoint Claude Code calls after login). Say Hi is executed through the local Claude Code CLI, which communicates
  with Anthropic as Claude Code normally does.
- This tool is for managing **your own** accounts.
- The usage endpoint and the token-refresh flow are **unofficial** and may change or stop working
  on Anthropic's side.
- Currently the file-based `.credentials.json` model is supported (Windows/Linux). The macOS
  Keychain is not supported yet.

## Usage history and analytics

Turn on `tursoftClaudeSwitcher.usageHistory.enabled` (or the **Collect usage history** switch at the
top of the analytics page, which also turns it off) to record every saved account's limits once a minute (`usageHistory.intervalSeconds`).
Readings stay on this computer, in the extension's storage; unchanged readings are stored only
every 15 minutes, and data older than `usageHistory.retentionDays` (90) is deleted.

**Show usage analytics** (the chart icon in the panel's title bar) charts that history, one chart per limit
(5h, weekly, Fable, ...):

- ranges of 1 day, 1 week, 1 month, 3 months, everything kept, or a custom from/to;
- one shared legend at the left lists the accounts in their chart colors; click an account to show
  or hide it in every chart (one, several, or all accounts can share a chart);
- **Limit %** (how full each limit was) or **Usage** (how much of the limit was used in each
  interval, from the change between readings; a drop counts as a reset);
- line, area, bar, stacked bar, pie, or doughnut charts.

**Delete collected usage history** removes all recorded readings.

## Availability calendar

**Show account availability calendar** (the calendar icon in the title bar, left of Refresh) shows when every account can be used,
as a week from Monday to Sunday or, after clicking a day, hour by hour:

- the same search, **All / Available / Limited**, plan and model-limit filters and sort orders as
  the accounts panel; the calendar starts from the panel's current choices when it opens and then
  keeps its own, so you can try other views without changing the panel;
- in **Custom order**, drag an account's row onto another (or focus its grip and press Up / Down)
  to reorder; this changes the same saved order the accounts panel uses;
- below the timeline, a **Right now** card per account: available now, or how long until it is usable again, with
  each limit's current percent and a **Switch** button for accounts that are available;
- for each limit you tick under **Limits** (**5h**, **Fable**, and, when an account has them,
  weekly and other model-specific limits), a lane under the account's name. With exactly one limit
  ticked, its bar sits beside the name instead; with none ticked, an overall bar shows whether any
  limit blocks the account;
- green = available, amber = 80%+ used, red = limited, grey = no data; markers show reset times
  and a red line shows now.

The past comes from collected usage history (turn collection on from the analytics page); the future is projected from the latest reading
(a used-up limit stays blocked until its reset time, then counts as free) and is drawn striped.

## Backup and restore

Use **Back up** / **Restore** in the panel's **⋯** title menu (or the commands above). The
backup is a standard ZIP whose single entry `accounts.json` is AES-256 encrypted with your
password, so it can also be opened with 7-Zip. It contains **login tokens**: anyone with the file
and the password can use those accounts, so store it like a password. The backup also keeps
the panel's sort and filter choices and your user-level extension settings (except
`credentialsPath`, which is specific to each machine); restoring applies them.

Restoring merges the backup into the current list. Missing accounts are added. For accounts that
already exist, the backup's tokens are used only if they are newer. Refresh tokens rotate, so
tokens in an old backup may already be spent. Use **Reauthorize** on such accounts. Do not run the
same restored account on two machines at once; each rotation invalidates the other copy.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (npm included)
- VS Code 1.85 or newer
- Claude Code installed, for testing login and Say Hi

```bash
npm install
```

### Compile

| Script | What it does |
| --- | --- |
| `npm run compile` | one-off development build to `dist/extension.js` (with source maps) |
| `npm run watch` | rebuilds on every change in `src/` |
| `npm run package` | minified production build (what gets shipped) |
| `npm run typecheck` | runs `tsc --noEmit`; esbuild does not type-check |
| `npm run test:smoke` | runs the smoke tests in `test/` |

The webview pages (`webview/*.js`: the accounts panel, usage analytics, and availability
calendar) are bundled by esbuild into `dist/webview/`, so run `npm run compile` (or `watch`) after
editing them; only the stylesheets in `media/` are loaded as-is. Logic shared by pages, such as
sorting and filtering the account list, lives in `src/` and is imported by the page scripts.

### Run and debug in VS Code

1. Open this folder in VS Code.
2. Press **F5** (or **Run and Debug → Run Extension**). This compiles the extension and opens an
   **Extension Development Host** window with it loaded.
3. In that window, open the **MultiAccount** icon in the activity bar.
4. After editing code, run **Developer: Reload Window** (`Ctrl+R` / `Cmd+R`) in the Extension
   Development Host. Keep `npm run watch` running to rebuild automatically.
5. To debug the webview, run **Developer: Open Webview Developer Tools** in the Extension
   Development Host.

The development host shares your real `~/.claude` credentials and VS Code SecretStorage. Be
careful with **Switch**, **Remove**, and logins while testing.

### Package and install locally

```bash
npm run build:vsix
```

This creates `tursoft-claude-code-account-switcher-<version>.vsix` in the project root. Install it
into your regular VS Code:

```bash
code --install-extension tursoft-claude-code-account-switcher-<version>.vsix
```

Or use **Extensions → ⋯ → Install from VSIX…**, then reload the window. To remove it, uninstall it
from the Extensions view. Run `npx vsce ls` to list the files that will go into the package;
exclusions are configured in `.vscodeignore`.

### Publish to the Visual Studio Marketplace

1. **Create a publisher** at <https://marketplace.visualstudio.com/manage> (sign in with a
   Microsoft account). The publisher **ID** (lowercase, no spaces, e.g. `tursoft`) must match
   the `publisher` field in `package.json` exactly.
2. **Create a Personal Access Token** in Azure DevOps (<https://dev.azure.com> → *User settings →
   Personal access tokens*) with **Organization: All accessible organizations** and the scope
   **Marketplace → Manage**.
3. **Log in** with vsce (it prompts for the token):

   ```bash
   npx vsce login <publisher-id>
   ```

4. **Bump the version** in `package.json` and add an entry to `CHANGELOG.md`. Alternatively, let
   vsce bump the version for you (see the next step).
5. **Publish**:

   ```bash
   npx vsce publish            # publishes the version in package.json
   npx vsce publish patch      # or: bump patch/minor/major, commit, tag and publish
   ```

   `vscode:prepublish` runs the production build automatically. You can also upload a `.vsix`
   built with `npm run build:vsix` manually on the publisher management page.

The listing usually appears within a few minutes. The Marketplace shows `README.md` as the
extension page, `CHANGELOG.md` as the changelog, and uses `icon` and `galleryBanner` from
`package.json`. To publish to [Open VSX](https://open-vsx.org/) (VSCodium, Cursor, etc.) too,
use `npx ovsx publish -p <token>` with a token from open-vsx.org.

## License

MIT
