#!/usr/bin/env node
/*
 * Stages single hunks of a file: `git add -p` without the interactive prompt.
 *
 *   node hunks.cjs list  <file> [--zero]          numbered hunks with their first changed lines
 *   node hunks.cjs show  <file> <n> [--zero]      one hunk in full
 *   node hunks.cjs stage <file> <1,3-4> [--zero]  stage only those hunks
 *
 * Hunks come from the file's unstaged diff (working tree against the index), so the numbers
 * change once some are staged: list again after every stage. --zero diffs without context
 * lines, which splits changes that sit close together into separate hunks.
 * Untracked, binary, deleted, and renamed files are staged whole with `git add`.
 */
"use strict";

const { spawnSync } = require("child_process");

function fail(message) {
  process.stderr.write(`hunks: ${message}\n`);
  process.exit(1);
}

function git(args, input) {
  const r = spawnSync("git", args, { input, maxBuffer: 1 << 28 });
  if (r.error) fail(r.error.message);
  // latin1 keeps every byte as is (UTF-8 text, CRLF line ends), so the patch round-trips.
  return { code: r.status, out: r.stdout.toString("latin1"), err: r.stderr.toString() };
}

/** The file's unstaged diff: the header lines and the hunks (each starting with its @@ line). */
function parse(file, zero) {
  const r = git(["diff", "--no-color", "--no-ext-diff", zero ? "-U0" : "-U3", "--", file]);
  if (r.code !== 0) fail(r.err.trim() || `git diff failed for ${file}`);
  if (!r.out) fail(`no unstaged changes in ${file} (an untracked file is staged whole with git add)`);
  if (/^(Binary files |GIT binary patch)/m.test(r.out)) fail(`${file} is binary: stage it whole with git add`);
  if (/^diff --git /m.test(r.out) && r.out.split(/^diff --git /m).length > 2) fail(`${file} matches more than one file: pass a single file`);
  const lines = r.out.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const first = lines.findIndex((l) => l.startsWith("@@"));
  if (first < 0) fail(`${file} has no text hunks (a mode change or rename): stage it whole with git add`);
  const header = lines.slice(0, first);
  const hunks = [];
  for (const line of lines.slice(first)) {
    if (line.startsWith("@@")) hunks.push([line]);
    else hunks[hunks.length - 1].push(line);
  }
  return { header, hunks };
}

/** "1,3-4" -> [1, 3, 4], each within 1..count. */
function pick(spec, count) {
  const out = new Set();
  for (const part of String(spec || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) fail(`bad hunk list "${spec}": use e.g. 1,3-4`);
    const from = Number(m[1]);
    const to = Number(m[2] || m[1]);
    for (let n = from; n <= to; n++) {
      if (n < 1 || n > count) fail(`hunk ${n} does not exist: the file has ${count}`);
      out.add(n);
    }
  }
  if (out.size === 0) fail("no hunks given");
  return [...out].sort((a, b) => a - b);
}

/** A diff line for the screen: decoded as UTF-8, without its CR, shortened. */
function clip(line) {
  const s = Buffer.from(line, "latin1").toString("utf8").replace(/\r$/, "");
  return s.length > 110 ? s.slice(0, 107) + "..." : s;
}

const [cmd, file, ...rest] = process.argv.slice(2);
const zero = rest.includes("--zero");
const args = rest.filter((a) => a !== "--zero");
if (!["list", "show", "stage"].includes(cmd) || !file) {
  fail("usage: hunks.cjs list|show|stage <file> [hunks] [--zero]");
}
const { header, hunks } = parse(file, zero);

if (cmd === "list") {
  hunks.forEach((h, i) => {
    const changed = h.slice(1).filter((l) => l.startsWith("+") || l.startsWith("-"));
    const added = changed.filter((l) => l.startsWith("+")).length;
    console.log(`#${i + 1} ${clip(h[0])}  (+${added} -${changed.length - added})`);
    for (const l of changed.slice(0, 4)) console.log("    " + clip(l));
    if (changed.length > 4) console.log(`    ... ${changed.length - 4} more changed lines`);
  });
} else if (cmd === "show") {
  const [n] = pick(args[0], hunks.length);
  process.stdout.write(Buffer.from(hunks[n - 1].join("\n") + "\n", "latin1"));
} else {
  const chosen = pick(args[0], hunks.length);
  const patch = Buffer.from([...header, ...chosen.flatMap((n) => hunks[n - 1])].join("\n") + "\n", "latin1");
  const apply = ["apply", "--cached", "--recount", ...(zero ? ["--unidiff-zero"] : [])];
  const check = git([...apply, "--check", "-"], patch);
  if (check.code !== 0) fail(`the hunks do not apply: ${check.err.trim()}`);
  const done = git([...apply, "-"], patch);
  if (done.code !== 0) fail(done.err.trim());
  console.log(`staged hunk${chosen.length > 1 ? "s" : ""} ${chosen.join(",")} of ${hunks.length} in ${file}`);
}
