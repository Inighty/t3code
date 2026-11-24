import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveManagedDiff3Conflicts,
  syncUpstreamWithIos17,
} from "./sync-upstream-ios17.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeBaseRepo(dir, { deploymentTarget = "18.0", podIos = "18.0", relayMin = 18 } = {}) {
  mkdirSync(path.join(dir, "apps/mobile/modules/t3-native-controls/ios"), { recursive: true });
  mkdirSync(path.join(dir, "packages/contracts/src"), { recursive: true });
  mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });

  writeFileSync(
    path.join(dir, "apps/mobile/app.config.ts"),
    [
      "export default {",
      "  plugins: [",
      '    ["expo-build-properties", {',
      "      ios: {",
      `        deploymentTarget: "${deploymentTarget}",`,
      '        extraPods: [{ name: "GoogleUtilities", modular_headers: true }],',
      "      },",
      "    }],",
      "  ],",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    path.join(dir, "apps/mobile/modules/t3-native-controls/ios/T3NativeControls.podspec"),
    `Pod::Spec.new do |s|\n  s.platforms = { :ios => '${podIos}' }\nend\n`,
    "utf8",
  );

  writeFileSync(
    path.join(dir, "packages/contracts/src/relay.ts"),
    `export const Req = Schema.Struct({\n  iosMajorVersion: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(${relayMin}))),\n});\n`,
    "utf8",
  );
}

test("resolves iOS 17 vs 18 conflict while keeping adjacent upstream edits", () => {
  const conflicted = [
    "<<<<<<< HEAD",
    '        deploymentTarget: "17.0",',
    '        extraPods: [{ name: "GoogleUtilities", modular_headers: true }],',
    "||||||| base",
    '        deploymentTarget: "18.0",',
    '        extraPods: [{ name: "GoogleUtilities", modular_headers: true }],',
    "=======",
    '        deploymentTarget: "19.0",',
    '        extraPods: [{ name: "GoogleUtilities", modular_headers: true }, { name: "NewPod", modular_headers: true }],',
    ">>>>>>> upstream/main",
    "",
  ].join("\n");

  const res = resolveManagedDiff3Conflicts("apps/mobile/app.config.ts", conflicted);
  assert.equal(res.resolved, true, res.reason);
  assert.match(res.content, /deploymentTarget: "17\.0"/);
  assert.match(res.content, /NewPod/);
});

test("refuses to auto-resolve when fork modified unrelated lines in conflict hunk", () => {
  const conflicted = [
    "<<<<<<< HEAD",
    '        deploymentTarget: "17.0",',
    '        customForkFlag: true,',
    "||||||| base",
    '        deploymentTarget: "18.0",',
    "=======",
    '        deploymentTarget: "19.0",',
    ">>>>>>> upstream/main",
    "",
  ].join("\n");

  const res = resolveManagedDiff3Conflicts("apps/mobile/app.config.ts", conflicted);
  assert.equal(res.resolved, false);
});

test("merges upstream commits, fixes new iOS 18 podspec, and keeps iOS 17 on conflict", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sync-ios17-"));
  const upstreamDir = path.join(tmpDir, "upstream");
  const forkDir = path.join(tmpDir, "fork");

  try {
    mkdirSync(upstreamDir, { recursive: true });
    git(upstreamDir, "init");
    git(upstreamDir, "symbolic-ref", "HEAD", "refs/heads/main");
    git(upstreamDir, "config", "user.email", "test@example.com");
    git(upstreamDir, "config", "user.name", "Test");
    writeBaseRepo(upstreamDir, { deploymentTarget: "18.0", podIos: "18.0", relayMin: 18 });
    git(upstreamDir, "add", ".");
    git(upstreamDir, "commit", "-m", "initial upstream");

    git(tmpDir, "clone", upstreamDir, forkDir);
    git(forkDir, "config", "user.email", "fork@example.com");
    git(forkDir, "config", "user.name", "Fork");
    writeBaseRepo(forkDir, { deploymentTarget: "17.0", podIos: "17.0", relayMin: 17 });
    git(forkDir, "add", ".");
    git(forkDir, "commit", "-m", "enable iOS 17.0");

    // Upstream bumps deploymentTarget right next to extraPods AND adds a new iOS 18 module
    writeBaseRepo(upstreamDir, { deploymentTarget: "19.0", podIos: "19.0", relayMin: 19 });
    const appConfigPath = path.join(upstreamDir, "apps/mobile/app.config.ts");
    writeFileSync(
      appConfigPath,
      readFileSync(appConfigPath, "utf8").replace(
        '{ name: "GoogleUtilities", modular_headers: true }',
        '{ name: "GoogleUtilities", modular_headers: true }, { name: "UpstreamPod", modular_headers: true }',
      ),
      "utf8",
    );
    mkdirSync(path.join(upstreamDir, "apps/mobile/modules/t3-new-mod/ios"), { recursive: true });
    writeFileSync(
      path.join(upstreamDir, "apps/mobile/modules/t3-new-mod/ios/T3NewMod.podspec"),
      `Pod::Spec.new do |s|\n  s.platform = :ios, '18.0'\nend\n`,
      "utf8",
    );
    writeFileSync(path.join(upstreamDir, ".github/workflows/ci.yml"), "name: CI\n", "utf8");
    git(upstreamDir, "add", ".");
    git(upstreamDir, "commit", "-m", "upstream updates");

    const result = syncUpstreamWithIos17({
      rootDir: forkDir,
      upstreamUrl: upstreamDir,
      upstreamBranch: "main",
    });

    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.equal(result.workflowsChanged, true);
    assert.match(
      readFileSync(path.join(forkDir, "apps/mobile/app.config.ts"), "utf8"),
      /deploymentTarget: "17\.0"/,
    );
    assert.match(
      readFileSync(path.join(forkDir, "apps/mobile/app.config.ts"), "utf8"),
      /UpstreamPod/,
    );
    assert.match(
      readFileSync(
        path.join(forkDir, "apps/mobile/modules/t3-new-mod/ios/T3NewMod.podspec"),
        "utf8",
      ),
      /'17\.0'/,
    );
    assert.match(
      readFileSync(path.join(forkDir, "packages/contracts/src/relay.ts"), "utf8"),
      /isGreaterThanOrEqualTo\(17\)/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("aborts cleanly on non-iOS-17 merge conflicts", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sync-ios17-conflict-"));
  const upstreamDir = path.join(tmpDir, "upstream");
  const forkDir = path.join(tmpDir, "fork");

  try {
    mkdirSync(upstreamDir, { recursive: true });
    git(upstreamDir, "init");
    git(upstreamDir, "symbolic-ref", "HEAD", "refs/heads/main");
    git(upstreamDir, "config", "user.email", "test@example.com");
    git(upstreamDir, "config", "user.name", "Test");
    writeBaseRepo(upstreamDir);
    writeFileSync(path.join(upstreamDir, "README.md"), "base\n", "utf8");
    git(upstreamDir, "add", ".");
    git(upstreamDir, "commit", "-m", "base");

    git(tmpDir, "clone", upstreamDir, forkDir);
    git(forkDir, "config", "user.email", "fork@example.com");
    git(forkDir, "config", "user.name", "Fork");
    writeFileSync(path.join(forkDir, "README.md"), "fork edit\n", "utf8");
    git(forkDir, "add", ".");
    git(forkDir, "commit", "-m", "fork edit");

    writeFileSync(path.join(upstreamDir, "README.md"), "upstream edit\n", "utf8");
    git(upstreamDir, "add", ".");
    git(upstreamDir, "commit", "-m", "upstream edit");

    const result = syncUpstreamWithIos17({
      rootDir: forkDir,
      upstreamUrl: upstreamDir,
      upstreamBranch: "main",
    });

    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.match(result.conflictFiles[0], /README\.md/);
    assert.equal(git(forkDir, "status", "--porcelain"), "");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
