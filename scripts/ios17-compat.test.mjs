import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkAndFixIos17Compat, fixTextForFile, isIos17ManagedPath } from "./ios17-compat.mjs";

function writeRepoFixture(rootDir, { deploymentTarget = "18.0", podspecIos = "18.0", relayMin = 18 } = {}) {
  mkdirSync(path.join(rootDir, "apps/mobile/modules/t3-native-controls/ios"), { recursive: true });
  mkdirSync(path.join(rootDir, "apps/mobile/modules/t3-preview-tunnel/ios"), { recursive: true });
  mkdirSync(path.join(rootDir, "packages/contracts/src"), { recursive: true });

  writeFileSync(
    path.join(rootDir, "apps/mobile/app.config.ts"),
    `export default {
      plugins: [
        ["expo-build-properties", { ios: { deploymentTarget: "${deploymentTarget}" } }],
      ],
    };\n`,
    "utf8",
  );

  writeFileSync(
    path.join(rootDir, "apps/mobile/modules/t3-native-controls/ios/T3NativeControls.podspec"),
    `Pod::Spec.new do |s|
  s.platforms = {
    :ios => '${podspecIos}',
  }
end\n`,
    "utf8",
  );

  writeFileSync(
    path.join(rootDir, "apps/mobile/modules/t3-preview-tunnel/ios/T3PreviewTunnel.podspec"),
    `Pod::Spec.new do |s|
  s.platform = :ios, '${podspecIos}'
end\n`,
    "utf8",
  );

  writeFileSync(
    path.join(rootDir, "packages/contracts/src/relay.ts"),
    `export const RelayDeviceRegistrationRequest = Schema.Struct({
  iosMajorVersion: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(${relayMin}))),
});
export const RelayListDevicesResponseV1 = Schema.Struct({
  devices: Schema.Array(Schema.Struct({
    iosMajorVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(${relayMin})),
  })),
});\n`,
    "utf8",
  );
}

test("repo passes iOS 17.0 compatibility check", () => {
  const result = checkAndFixIos17Compat({ rootDir: process.cwd() });
  assert.equal(result.ok, true, result.issues.join("\n"));
  assert.ok(result.checkedFiles.length >= 6);
});

test("detects iOS 18 targets and repairs them idempotently with --fix", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ios17-compat-"));
  try {
    writeRepoFixture(tempDir, { deploymentTarget: "18.0", podspecIos: "18.0", relayMin: 18 });

    const checkBefore = checkAndFixIos17Compat({ rootDir: tempDir, fix: false });
    assert.equal(checkBefore.ok, false);
    assert.equal(checkBefore.issues.length, 5);

    const fixed = checkAndFixIos17Compat({ rootDir: tempDir, fix: true });
    assert.equal(fixed.ok, true, fixed.issues.join("\n"));
    assert.equal(fixed.changedFiles.length, 4);

    const checkAfter = checkAndFixIos17Compat({ rootDir: tempDir, fix: false });
    assert.equal(checkAfter.ok, true);
    assert.equal(checkAfter.changedFiles.length, 0);

    const relay = readFileSync(path.join(tempDir, "packages/contracts/src/relay.ts"), "utf8");
    assert.match(relay, /isGreaterThanOrEqualTo\(17\)/);
    assert.doesNotMatch(relay, /isGreaterThanOrEqualTo\(18\)/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifies generated prebuild output when --check-prebuild is enabled", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ios17-prebuild-"));
  try {
    writeRepoFixture(tempDir, { deploymentTarget: "17.0", podspecIos: "17.0", relayMin: 17 });
    mkdirSync(path.join(tempDir, "apps/mobile/ios/T3Code.xcodeproj"), { recursive: true });
    writeFileSync(
      path.join(tempDir, "apps/mobile/ios/Podfile.properties.json"),
      JSON.stringify({ "ios.deploymentTarget": "17.0" }),
      "utf8",
    );
    writeFileSync(
      path.join(tempDir, "apps/mobile/ios/T3Code.xcodeproj/project.pbxproj"),
      `IPHONEOS_DEPLOYMENT_TARGET = 17.0;\n`,
      "utf8",
    );
    assert.equal(checkAndFixIos17Compat({ rootDir: tempDir, checkPrebuild: true }).ok, true);

    writeFileSync(
      path.join(tempDir, "apps/mobile/ios/T3Code.xcodeproj/project.pbxproj"),
      `IPHONEOS_DEPLOYMENT_TARGET = 18.0;\n`,
      "utf8",
    );
    const failed = checkAndFixIos17Compat({ rootDir: tempDir, checkPrebuild: true });
    assert.equal(failed.ok, false);
    assert.match(failed.issues[0], /IPHONEOS_DEPLOYMENT_TARGET = 18\.0/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("identifies managed paths and preserves surrounding text when fixing", () => {
  assert.equal(isIos17ManagedPath("apps/mobile/modules/new-mod/ios/NewMod.podspec"), true);
  assert.equal(isIos17ManagedPath("apps/mobile/src/App.tsx"), false);

  const result = fixTextForFile(
    "apps/mobile/app.config.ts",
    `ios: {\n  deploymentTarget: "26.0",\n  extraPods: [{ name: "NewPod", modular_headers: true }],\n}`,
  );
  assert.equal(result.changed, true);
  assert.match(result.content, /deploymentTarget: "17\.0"/);
  assert.match(result.content, /NewPod/);
});
