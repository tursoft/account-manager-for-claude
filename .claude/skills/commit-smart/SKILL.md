---
name: commit-smart
description: Review the uncommitted changes, group related ones by intent, and create focused commits with short Conventional Commit messages. Use when the user runs /commit-smart.
argument-hint: "[plan] [grouping hints]"
disable-model-invocation: true
---

# commit-smart

Turns the working tree into a few focused commits: review first, then one topic per commit, each
with a short message in the repo's style. Group by **intent**, not by file or folder; one file can
feed several commits through hunk staging.

`$ARGUMENTS`: `plan` (or `dry-run`) stops after the plan in step 3. Any other text is a grouping
hint from the user and wins over your own judgment.

## 1. Snapshot

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD                  # ORIG: for the final check, and the undo
git status --porcelain=v1 -uall
git diff --stat HEAD                # staged and unstaged, against HEAD
git log -n 20 --format=%s           # the message style to follow
```

Stop and tell the user when:
- there is nothing to commit;
- a merge, rebase, cherry-pick, or revert is in progress (`.git/MERGE_HEAD`, `.git/rebase-merge`,
  `.git/rebase-apply`, `.git/CHERRY_PICK_HEAD`, `.git/REVERT_HEAD`);
- the branch is `main` (or `master`): ask whether to commit there or on a new branch, and suggest
  a name from the main topic (`feat/...`, `fix/...`).

## 2. Review

Read the whole diff (`git diff HEAD`) and every untracked file in full. Don't judge from `--stat`
or file names. For each hunk, note what it does and why. Then sort what you found:

**Blockers:** commit nothing; list them and ask the user.
- Secrets: tokens, API keys, passwords, private keys, `.env*`, `*.pem`, credential files,
  connection strings with passwords.
- Conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
- A failing check (below). The user may still want to commit work in progress; ask.

**Leave out without asking** (name them in the report): local or generated files such as
`.claude/settings.local.json`, editor folders, `*.log`, build output (`dist/`, `out/`), packages
(`*.vsix`), and scratch files. Most are git-ignored already; this catches the rest.

**Warnings:** show them in the plan and still commit.
- Debug code added in this diff (`console.log`, `debugger`, `.only(` in tests).
- New TODO or FIXME comments, or large blocks of commented-out code.
- Whitespace-only churn in a file with no other change.
- Very large or binary files.

**Check:** run the project's fast static check. Here that is `npm run typecheck`. Elsewhere, use a
`typecheck` or `lint` script, `tsc --noEmit`, `cargo check`, or `go vet ./...`. Don't run slow
test suites unless the user asks (here, `npm run test:smoke` takes about a minute); report that
they were not run.

## 3. Group and plan

A topic is one reason for a change: something a reviewer could accept or revert on its own.

| Keep together | Split apart |
|---|---|
| A feature + its tests + its docs and README lines | Feature A vs. an unrelated feature B |
| `package.json` + its lockfile change | A bug fix found while building a feature |
| A rename + every call site it touches | Formatting or whitespace churn vs. logic |
| A new module + the first code that uses it | A dependency bump vs. code that doesn't need it |

A version bump (`package.json` and `package-lock.json` version fields only) is its own
`chore(release): <version>` commit, last.

Order the commits so each one builds on its own: types and helpers before their callers, refactors
before the features that use them, unrelated chores last.

Show the plan:

```
1. feat(propose): let accounts be excluded from proposals
   src/propose.ts, src/types.ts, webview/panel.js, media/panel.css, test/smoke.ts, README.md
2. chore(release): 1.1.2
   package.json, package-lock.json
Left out: .claude/settings.local.json (local settings)
Warnings: none · Check: typecheck passed · Tests: not run
```

Unless this is a `plan` run, go on right after showing it. The commits are local and easy to redo.

## 4. Write short messages

- Use `type(scope): summary`. The types are feat, fix, refactor, perf, docs, test, build, chore,
  style, and ci. The scope is the area name the history already uses (settings, panel, usage,
  propose, readme, release, ...); leave it out when no single area fits.
- Write the summary in the imperative, lower case after the colon, with no final period, and at
  most 60 characters. Name the behavior that changed, not the files: "update panel.js" is wrong.
- By default there is no body. Add one or two lines only when the subject can't show the why: the
  cause of a fix, or a breaking change.
- If your session's instructions specify an attribution trailer (such as `Co-Authored-By`), add
  it after a blank line.

## 5. Commit each group

1. Clear the index once: `git reset -q`. This is a mixed reset, so every change stays in the
   working tree.
2. Stage the group:
   - **Whole files:** `git add -- <paths>`. For deletions and renames, use `git add -A -- <paths>`.
   - **Part of a file:** use the helper next to this skill, run from the repository root:

     ```bash
     node .claude/skills/commit-smart/hunks.cjs list  <file>        # numbered hunks
     node .claude/skills/commit-smart/hunks.cjs show  <file> 2      # one hunk in full
     node .claude/skills/commit-smart/hunks.cjs stage <file> 1,3-4  # stage those hunks only
     ```

     Hunk numbers count what is still unstaged, so list again after each `stage`. Add `--zero`
     to split changes that sit close together into separate hunks, and use it on `list`,
     `show`, and `stage` alike. Untracked, binary, and renamed files can only be staged whole.
     If a hunk mixes two topics and can't be split, give it to the main topic and say so.
3. Check that exactly this group is staged: `git diff --cached --stat`, then `git diff --cached`.
4. Write the message to a file in the session scratchpad, never in the repo. Use the Write tool or
   a Bash heredoc; PowerShell's `>` writes UTF-16. Then run `git commit -F <file>`.

Never use `--no-verify`, never amend an earlier commit, and never push. If a hook fails, fix the
cause, stage again, and make a new commit.

## 6. Verify and report

```bash
git status --porcelain=v1 -uall     # only the left-out files remain
git log --oneline ORIG..HEAD
git diff --stat ORIG HEAD           # the snapshot, minus what was left out
```

Report:
- each commit as short hash and subject;
- what was left out, and why;
- warnings, and hunks assigned by judgment;
- the checks that ran, and the ones that didn't;
- the undo, `git reset --soft <ORIG>`, which brings everything back as uncommitted changes.
