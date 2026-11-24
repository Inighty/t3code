#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkAndFixIos17Compat,
  fixTextForFile,
  isIos17ManagedPath,
} from "../../scripts/ios17-compat.mjs";

const DEFAULT_UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";
const DEFAULT_UPSTREAM_BRANCH = "main";

function runGit(rootDir, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (!allowFailure && result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${details}`);
  }
  return result;
}

function writeGithubOutput(values) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`);
  appendFileSync(outputFile, `${lines.join("\n")}\n`, "utf8");
}

function splitLinesPreservingEol(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (hasTrailingNewline) {
    lines.pop();
  }
  return { lines, eol, hasTrailingNewline };
}

/**
 * Resolves diff3 conflict hunks only when `ours` differs from `base` strictly on
 * iOS 17 compatibility adjustments. Any non-iOS-17 divergence aborts cleanly.
 */
export function resolveManagedDiff3Conflicts(relPath, content) {
  if (!isIos17ManagedPath(relPath)) {
    return { resolved: false, reason: `${relPath} is not an iOS 17 managed file`, content };
  }

  const { lines, eol, hasTrailingNewline } = splitLinesPreservingEol(content);
  const outLines = [];
  let conflictCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("<<<<<<< ")) {
      outLines.push(line);
      continue;
    }

    conflictCount += 1;
    const oursLines = [];
    const baseLines = [];
    const theirsLines = [];
    let state = "ours";
    let sawBase = false;
    let sawSep = false;
    let sawEnd = false;

    for (i += 1; i < lines.length; i += 1) {
      const current = lines[i];
      if (state === "ours" && current.startsWith("||||||| ")) {
        sawBase = true;
        state = "base";
        continue;
      }
      if ((state === "ours" || state === "base") && current === "=======") {
        sawSep = true;
        state = "theirs";
        continue;
      }
      if (state === "theirs" && current.startsWith(">>>>>>> ")) {
        sawEnd = true;
        break;
      }
      if (state === "ours") {
        oursLines.push(current);
      } else if (state === "base") {
        baseLines.push(current);
      } else {
        theirsLines.push(current);
      }
    }

    if (!sawBase || !sawSep || !sawEnd) {
      return {
        resolved: false,
        reason: `${relPath}: conflict block #${conflictCount} is missing diff3 markers`,
        content,
      };
    }

    const oursText = oursLines.join(eol);
    const baseText = baseLines.join(eol);
    const theirsText = theirsLines.join(eol);
    const normalizedBase = fixTextForFile(relPath, baseText, { allowMissing: true });

    if (!normalizedBase.changed || normalizedBase.content !== oursText) {
      return {
        resolved: false,
        reason: `${relPath}: conflict block #${conflictCount} contains non-iOS-17 edits`,
        content,
      };
    }

    const adaptedTheirs = fixTextForFile(relPath, theirsText, { allowMissing: true });
    if (adaptedTheirs.content.length > 0) {
      outLines.push(...adaptedTheirs.content.split(/\r?\n/));
    }
  }

  if (conflictCount === 0) {
    return {
      resolved: false,
      reason: `${relPath}: marked unmerged without textual conflict markers (tree/delete conflict)`,
      content,
    };
  }

  const resolvedText =
    outLines.join(eol) + (hasTrailingNewline && outLines.length > 0 ? eol : "");
  return { resolved: true, reason: "", content: resolvedText };
}

function getUnmergedFiles(rootDir) {
  const result = runGit(rootDir, ["diff", "--name-only", "--diff-filter=U"]);
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function syncUpstreamWithIos17({
  rootDir = process.cwd(),
  upstreamUrl = DEFAULT_UPSTREAM_URL,
  upstreamBranch = DEFAULT_UPSTREAM_BRANCH,
  upstreamRef = null,
  dryRun = false,
} = {}) {
  const targetRef = upstreamRef ?? "FETCH_HEAD";
  if (!upstreamRef) {
    runGit(rootDir, ["fetch", "--no-tags", upstreamUrl, `refs/heads/${upstreamBranch}`]);
  }

  const beforeSha = runGit(rootDir, ["rev-parse", "HEAD"]).stdout.trim();
  const upstreamSha = runGit(rootDir, ["rev-parse", targetRef]).stdout.trim();
  const aheadCount = Number.parseInt(
    runGit(rootDir, ["rev-list", "--count", `HEAD..${upstreamSha}`]).stdout.trim(),
    10,
  );

  let mergedNewCommits = false;
  if (aheadCount > 0) {
    const mergeResult = runGit(
      rootDir,
      ["-c", "merge.conflictStyle=diff3", "merge", "--no-commit", "--no-ff", upstreamSha],
      { allowFailure: true },
    );

    const unmerged = getUnmergedFiles(rootDir);
    if (unmerged.length > 0) {
      const unresolved = [];
      for (const relPath of unmerged) {
        const fullPath = path.join(rootDir, relPath);
        const text = readFileSync(fullPath, "utf8");
        const resolution = resolveManagedDiff3Conflicts(relPath, text);
        if (!resolution.resolved) {
          unresolved.push(`${relPath} (${resolution.reason})`);
          continue;
        }
        writeFileSync(fullPath, resolution.content, "utf8");
        runGit(rootDir, ["add", "--", relPath]);
      }

      if (unresolved.length > 0) {
        runGit(rootDir, ["merge", "--abort"], { allowFailure: true });
        return {
          ok: false,
          updated: false,
          conflict: true,
          conflictFiles: unresolved,
          workflowsChanged: false,
          beforeSha,
          headSha: beforeSha,
          upstreamSha,
        };
      }
    } else if (mergeResult.status !== 0) {
      runGit(rootDir, ["merge", "--abort"], { allowFailure: true });
      throw new Error(
        `git merge failed without unmerged paths: ${(mergeResult.stderr || mergeResult.stdout).trim()}`,
      );
    }

    mergedNewCommits = true;
  }

  const compatFix = checkAndFixIos17Compat({ rootDir, fix: true });
  if (!compatFix.ok) {
    if (mergedNewCommits) {
      runGit(rootDir, ["merge", "--abort"], { allowFailure: true });
    }
    throw new Error(`iOS 17.0 verification failed after merge:\n${compatFix.issues.join("\n")}`);
  }

  for (const relPath of compatFix.changedFiles) {
    runGit(rootDir, ["add", "--", relPath]);
  }

  const verifyAfter = checkAndFixIos17Compat({ rootDir, fix: false });
  if (!verifyAfter.ok) {
    if (mergedNewCommits) {
      runGit(rootDir, ["merge", "--abort"], { allowFailure: true });
    }
    throw new Error(`iOS 17.0 check failed after staging fixes:\n${verifyAfter.issues.join("\n")}`);
  }

  let headSha = beforeSha;
  let updated = false;
  if (!dryRun) {
    if (mergedNewCommits) {
      runGit(rootDir, [
        "commit",
        "-m",
        `chore(sync): merge upstream ${upstreamSha.slice(0, 7)} (keep iOS 17.0)`,
      ]);
      updated = true;
    } else if (compatFix.changedFiles.length > 0) {
      runGit(rootDir, ["commit", "-m", "chore(mobile): preserve iOS 17.0 compatibility"]);
      updated = true;
    }
    headSha = runGit(rootDir, ["rev-parse", "HEAD"]).stdout.trim();
  } else {
    updated = mergedNewCommits || compatFix.changedFiles.length > 0;
  }

  let workflowsChanged = false;
  if (updated && !dryRun) {
    const wfDiff = runGit(rootDir, [
      "diff",
      "--name-only",
      `${beforeSha}..${headSha}`,
      "--",
      ".github/workflows/",
    ]).stdout.trim();
    workflowsChanged = wfDiff.length > 0;
  } else if (mergedNewCommits) {
    const wfDiff = runGit(rootDir, [
      "diff",
      "--cached",
      "--name-only",
      "--",
      ".github/workflows/",
    ]).stdout.trim();
    workflowsChanged = wfDiff.length > 0;
  }

  if (dryRun && mergedNewCommits) {
    runGit(rootDir, ["merge", "--abort"], { allowFailure: true });
  }

  return {
    ok: true,
    updated,
    conflict: false,
    conflictFiles: [],
    workflowsChanged,
    beforeSha,
    headSha,
    upstreamSha,
    fixedFiles: compatFix.changedFiles,
  };
}

function parseCliArgs(argv) {
  const opts = {
    upstreamUrl: DEFAULT_UPSTREAM_URL,
    upstreamBranch: DEFAULT_UPSTREAM_BRANCH,
    upstreamRef: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--upstream-url" && argv[i + 1]) {
      opts.upstreamUrl = argv[++i];
    } else if (arg === "--upstream-branch" && argv[i + 1]) {
      opts.upstreamBranch = argv[++i];
    } else if (arg === "--upstream-ref" && argv[i + 1]) {
      opts.upstreamRef = argv[++i];
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    }
  }
  return opts;
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const result = syncUpstreamWithIos17({
    rootDir: process.cwd(),
    ...opts,
  });

  writeGithubOutput({
    updated: result.updated,
    workflows_changed: result.workflowsChanged,
    conflict: result.conflict,
    conflict_files: result.conflictFiles.join(","),
    before_sha: result.beforeSha,
    head_sha: result.headSha,
    upstream_sha: result.upstreamSha,
  });

  if (result.conflict) {
    console.error("Upstream sync stopped due to manual merge conflict:");
    for (const file of result.conflictFiles) {
      console.error(`  - ${file}`);
    }
    process.exit(1);
  }

  console.log(
    result.updated
      ? `Synced upstream ${result.upstreamSha.slice(0, 7)} -> ${result.headSha.slice(0, 7)} (workflows_changed=${result.workflowsChanged})`
      : `Already up to date with upstream (${result.upstreamSha.slice(0, 7)}) and iOS 17.0 compatible.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
