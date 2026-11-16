---
name: publish
description: Release a new version of the Account Manager for Claude extension to the VS Code Marketplace - bump the version in package.json, run the checks, commit, push a version tag that triggers the GitHub Actions publish workflow (Marketplace Trusted Publishing, no PAT), watch it, and confirm the listing. Use when the user runs /publish or asks to release, ship, or publish a new version of this extension.
argument-hint: "[patch|minor|major|x.y.z]"
disable-model-invocation: true
---

# Publish a new version

Releases `tursoft.account-manager-for-claude` to the VS Code Marketplace. Publishing runs in
GitHub Actions (`.github/workflows/publish.yml`) with Marketplace **Trusted Publishing** (OIDC):
no Personal Access Token is stored or needed, and `vsce login` / `vsce publish` from this machine
are no longer used. Publishing is public and a version number can never be reused, so stop at the
first failed step and report it; don't work around it.

The argument chooses the new version: `patch` (the default), `minor`, `major`, or an exact
`x.y.z`. Run everything from the repository root in the Bash tool (Git Bash).

## 1. Look before releasing

- `git status --short`, `git branch --show-current`, and `git log --oneline -3`. Uncommitted
  changes will be part of the release commit, which is expected right after a change; list them
  in the report.
- `node -p "require('./package.json').version"`: the current version.

## 2. Bump the version

```bash
npm version <patch|minor|major|x.y.z> --no-git-tag-version
```

This updates `package.json` and `package-lock.json` only; `--no-git-tag-version` keeps npm from
committing and tagging on its own (the tag is pushed in step 5, after the checks).

## 3. Check locally

```bash
npm run prepublish:check > "$TEMP/precheck.txt" 2>&1; echo "exit $?"
grep -E "error TS|FAIL|ALL PASS" "$TEMP/precheck.txt"
```

It must end with `ALL PASS`. The request-queue check "the gap can be changed (0 = no pause)"
fails intermittently: when it is the only failure, rerun once. Any other failure stops the
release; report it and leave the bumped version in place. The workflow runs the same checks again.

Optionally build and install the package to try it first: `npm run deploy`.

## 4. Commit

Commit the pending changes (in focused commits if they span several topics) and the version bump
as `chore(release): <version>`.

## 5. Push the commit and the tag

Pushing is what publishes, so confirm with the user first unless they already asked to publish.

```bash
git push origin HEAD
git tag v<version> && git push origin v<version>
```

The tag must equal `v` + the `package.json` version, or the workflow stops.

## 6. Approval, then watch the workflow

```bash
sleep 5; gh run list --workflow publish.yml --limit 1
```

The job runs in the `marketplace` environment, which waits for the repository owner's approval
(the run shows "Waiting"). Approving is the user's release decision: never approve it yourself,
even if `gh` could. Give the user the run URL and ask them to choose **Review deployments →
marketplace → Approve and deploy**. Once they have, follow it:

```bash
gh run watch <run-id> --exit-status
```

On failure, read `gh run view <run-id> --log-failed`:

- **OIDC / token exchange / 401 / 403 at the publish step**: the publisher's Trusted Publishing
  policy is missing or doesn't match. Ask the user to check it at
  https://marketplace.visualstudio.com/manage/publishers/tursoft → **Trusted Publishing**: owner
  `tursoft`, repository `account-manager-for-claude`, workflow `publish.yml`, environment
  `marketplace`.
  Then rerun: `gh run rerun <run-id>` (`--skip-duplicate` makes reruns safe).
- **Tag does not match**: delete the tag (`git push origin :refs/tags/v<x>` and `git tag -d v<x>`),
  fix, and tag again. Only admins can create or delete `v*` tags (tag ruleset).
- **"Branch is not allowed to deploy to marketplace"**: the run was started on a branch; only
  `v*` tags may deploy.
- **"must be pinned to a full-length commit SHA" / action not allowed**: the repository allows
  only GitHub-owned actions pinned to a commit SHA; pin the new action the same way.
- **Tests**: same rule as step 3.

## 7. Confirm and report

The Marketplace validates a new version for a few minutes before listing it:

```bash
timeout 90 npx vsce show tursoft.account-manager-for-claude --json < /dev/null
```

Its `versions[0].version` should be the new version. If it still shows the previous one, say
that validation is pending, and check once more later in the session if there is a natural
point to do so.

Report:
- the version change (old → new), the tag, and the workflow run URL;
- the check results (any flaky rerun included);
- whether the listing shows it yet:
  https://marketplace.visualstudio.com/items?itemName=tursoft.account-manager-for-claude .
