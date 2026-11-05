---
name: publish
description: Release a new version of the Account Manager for Claude extension to the VS Code Marketplace - bump the version in package.json, run the checks, build the .vsix, publish it with vsce, and confirm the listing. Use when the user runs /publish or asks to release, ship, or publish a new version of this extension.
argument-hint: "[patch|minor|major|x.y.z]"
disable-model-invocation: true
---

# Publish a new version

Releases `tursoft.account-manager-for-claude` to the VS Code Marketplace. Publishing is public and
a version number can never be reused, so stop at the first failed step and report it; don't
work around it.

The argument chooses the new version: `patch` (the default), `minor`, `major`, or an exact
`x.y.z`. Run everything from the repository root in the Bash tool (Git Bash).

## 1. Look before releasing

- `git status --short` and `git log --oneline -3`: note uncommitted changes in the report.
  They will be part of the release, which is expected when the user publishes right after a
  change. Don't commit, tag, or push unless the user asks.
- `node -p "require('./package.json').version"`: the current version.

## 2. Bump the version

```bash
npm version <patch|minor|major|x.y.z> --no-git-tag-version
```

This updates `package.json` and `package-lock.json` only. `--no-git-tag-version` matters:
without it npm refuses a dirty working tree, and otherwise it commits and tags on its own.
Don't use `npm run release` (`vsce publish patch`) for the same reason.

## 3. Check

```bash
npm run prepublish:check > "$TEMP/precheck.txt" 2>&1; echo "exit $?"
grep -E "error TS|FAIL|ALL PASS" "$TEMP/precheck.txt"
```

This runs the typecheck and `test/smoke.ts`; it must end with `ALL PASS`. The request-queue check
"the gap can be changed (0 = no pause)" fails intermittently: when it is the only failure, rerun
once. Any other failure stops the release; report it, and leave the bumped version in place so
the user can decide.

## 4. Build the package

```bash
npm run build:vsix
```

This does a production esbuild build plus `vsce package`, and writes
`account-manager-for-claude-<version>.vsix` in the repository root (`*.vsix` is git-ignored).
Confirm the file exists and carries the new version:

```bash
unzip -p account-manager-for-claude-<version>.vsix extension/package.json | grep '"version"'
```

When the release is for a specific change, also grep the packaged `extension/dist/extension.js`
or `extension/dist/webview/panel.js` for a name from that change.

## 5. Publish

Publish the exact file that was built and checked, with stdin closed so a missing token fails
fast instead of waiting at a prompt:

```bash
timeout 170 npx vsce publish --packagePath account-manager-for-claude-<version>.vsix < /dev/null
```

Success ends with `DONE  Published tursoft.account-manager-for-claude v<version>.` The
publisher token is stored in the Windows credential store from an earlier `vsce login tursoft`.
Don't run `vsce ls-publishers` to check for it: it hangs here.

If publishing fails because no token is stored or the token expired, stop. Tell the user to run
`npx vsce login tursoft` in their own terminal with a new Azure DevOps personal access token
(scope: Marketplace > Manage), then run `/publish` again, or to upload the .vsix by hand at
https://marketplace.visualstudio.com/manage/publishers/tursoft. Never ask for the token in chat.

## 6. Confirm and report

The Marketplace validates a new version for a few minutes before listing it:

```bash
timeout 90 npx vsce show tursoft.account-manager-for-claude --json < /dev/null
```

Its `versions[0].version` should be the new version. If it still shows the previous one, say
that validation is pending, and check once more later in the session if there is a natural
point to do so.

Report:
- the version change (old → new) and the .vsix path;
- the check result (any flaky rerun included);
- the publish result and whether the listing shows it yet:
  https://marketplace.visualstudio.com/items?itemName=tursoft.account-manager-for-claude ;
- uncommitted changes that went into the release, with an offer to commit them and the version
  bump (for example `chore(release): <version>`).
