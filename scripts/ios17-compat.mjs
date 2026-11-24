#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const IOS_DEPLOYMENT_TARGET = "17.0";
export const IOS_MAJOR_VERSION = 17;

const APP_CONFIG_PATH = "apps/mobile/app.config.ts";
const RELAY_CONTRACTS_PATH = "packages/contracts/src/relay.ts";
const MODULES_DIR = "apps/mobile/modules";

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function parseMajorVersion(version) {
  const [majorText] = version.split(".");
  return Number.parseInt(majorText ?? "", 10);
}

export function isIos17ManagedPath(relPath) {
  const normalized = toPosixPath(relPath);
  if (normalized === APP_CONFIG_PATH || normalized === RELAY_CONTRACTS_PATH) {
    return true;
  }
  return /^apps\/mobile\/modules\/.*\.podspec$/.test(normalized);
}

export function fixTextForFile(relPath, content, { allowMissing = false } = {}) {
  const normalized = toPosixPath(relPath);
  const issues = [];
  let updated = content;

  if (normalized === APP_CONFIG_PATH) {
    let matchCount = 0;
    const next = updated.replace(
      /(\bdeploymentTarget\s*:\s*)(["'])(\d+(?:\.\d+)*)\2/g,
      (_full, prefix, quote, version) => {
        matchCount += 1;
        if (version !== IOS_DEPLOYMENT_TARGET) {
          issues.push(`${normalized}: ios.deploymentTarget is ${version} (expected ${IOS_DEPLOYMENT_TARGET})`);
          return `${prefix}${quote}${IOS_DEPLOYMENT_TARGET}${quote}`;
        }
        return _full;
      },
    );
    if (!allowMissing && matchCount === 0) {
      issues.push(`${normalized}: missing ios.deploymentTarget setting`);
    }
    updated = next;
    return { changed: updated !== content, content: updated, issues };
  }

  if (normalized === RELAY_CONTRACTS_PATH) {
    let matchCount = 0;
    const next = updated.replace(
      /(\biosMajorVersion\b[\s\S]{0,120}?Schema\.isGreaterThanOrEqualTo\()(\d+)(\))/g,
      (full, prefix, minMajorText, suffix) => {
        matchCount += 1;
        const minMajor = Number.parseInt(minMajorText, 10);
        if (minMajor > IOS_MAJOR_VERSION) {
          issues.push(
            `${normalized}: iosMajorVersion requires >= ${minMajor} (expected <= ${IOS_MAJOR_VERSION})`,
          );
          return `${prefix}${IOS_MAJOR_VERSION}${suffix}`;
        }
        return full;
      },
    );
    if (!allowMissing && matchCount === 0) {
      issues.push(`${normalized}: missing iosMajorVersion lower-bound schema check`);
    }
    updated = next;
    return { changed: updated !== content, content: updated, issues };
  }

  if (/^apps\/mobile\/modules\/.*\.podspec$/.test(normalized)) {
    const patterns = [
      /(\bs\.platform\s*=\s*:ios\s*,\s*)(["'])(\d+(?:\.\d+)*)\2/g,
      /(:ios\s*=>\s*)(["'])(\d+(?:\.\d+)*)\2/g,
      /(\bs\.ios\.deployment_target\s*=\s*)(["'])(\d+(?:\.\d+)*)\2/g,
    ];
    for (const pattern of patterns) {
      updated = updated.replace(pattern, (full, prefix, quote, version) => {
        if (parseMajorVersion(version) > IOS_MAJOR_VERSION) {
          issues.push(`${normalized}: podspec iOS target is ${version} (> ${IOS_DEPLOYMENT_TARGET})`);
          return `${prefix}${quote}${IOS_DEPLOYMENT_TARGET}${quote}`;
        }
        return full;
      });
    }
    return { changed: updated !== content, content: updated, issues };
  }

  return { changed: false, content, issues };
}

function collectPodspecs(rootDir) {
  const modulesRoot = path.join(rootDir, MODULES_DIR);
  if (!existsSync(modulesRoot)) {
    return [];
  }
  const ignoredDirs = new Set(["node_modules", "Pods", "build", ".git"]);
  const found = [];

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".podspec")) {
        found.push(toPosixPath(path.relative(rootDir, fullPath)));
      }
    }
  }

  walk(modulesRoot);
  return found;
}

function verifyPrebuildOutput(rootDir) {
  const issues = [];
  const podfilePropsPath = path.join(rootDir, "apps/mobile/ios/Podfile.properties.json");
  if (!existsSync(podfilePropsPath)) {
    issues.push("apps/mobile/ios/Podfile.properties.json does not exist after prebuild");
  } else {
    const props = JSON.parse(readFileSync(podfilePropsPath, "utf8"));
    if (props["ios.deploymentTarget"] !== IOS_DEPLOYMENT_TARGET) {
      issues.push(
        `apps/mobile/ios/Podfile.properties.json ios.deploymentTarget is ${String(props["ios.deploymentTarget"])} (expected ${IOS_DEPLOYMENT_TARGET})`,
      );
    }
  }

  const pbxprojPath = path.join(rootDir, "apps/mobile/ios/T3Code.xcodeproj/project.pbxproj");
  if (existsSync(pbxprojPath)) {
    const pbxproj = readFileSync(pbxprojPath, "utf8");
    for (const match of pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*(\d+(?:\.\d+)*);/g)) {
      if (parseMajorVersion(match[1]) > IOS_MAJOR_VERSION) {
        issues.push(
          `apps/mobile/ios/T3Code.xcodeproj/project.pbxproj contains IPHONEOS_DEPLOYMENT_TARGET = ${match[1]} (> ${IOS_DEPLOYMENT_TARGET})`,
        );
      }
    }
  }

  const podfilePath = path.join(rootDir, "apps/mobile/ios/Podfile");
  if (existsSync(podfilePath)) {
    const podfile = readFileSync(podfilePath, "utf8");
    for (const match of podfile.matchAll(/^\s*platform\s+:ios\s*,\s*(["'])(\d+(?:\.\d+)*)\1/gm)) {
      if (parseMajorVersion(match[2]) > IOS_MAJOR_VERSION) {
        issues.push(
          `apps/mobile/ios/Podfile pins platform :ios, '${match[2]}' (> ${IOS_DEPLOYMENT_TARGET})`,
        );
      }
    }
  }

  return issues;
}

export function checkAndFixIos17Compat({
  rootDir = process.cwd(),
  fix = false,
  checkPrebuild = false,
} = {}) {
  const targets = [APP_CONFIG_PATH, RELAY_CONTRACTS_PATH, ...collectPodspecs(rootDir)];
  const issues = [];
  const changedFiles = [];

  for (const relPath of targets) {
    const fullPath = path.join(rootDir, relPath);
    if (!existsSync(fullPath)) {
      issues.push(`${relPath}: expected file is missing`);
      continue;
    }

    const original = readFileSync(fullPath, "utf8");
    const result = fixTextForFile(relPath, original);
    if (fix && result.changed) {
      writeFileSync(fullPath, result.content, "utf8");
      changedFiles.push(relPath);
      const afterFix = fixTextForFile(relPath, result.content);
      issues.push(...afterFix.issues);
    } else {
      issues.push(...result.issues);
    }
  }

  if (checkPrebuild) {
    issues.push(...verifyPrebuildOutput(rootDir));
  }

  return {
    ok: issues.length === 0,
    checkedFiles: targets,
    changedFiles,
    issues,
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const fix = args.has("--fix");
  const checkPrebuild = args.has("--check-prebuild");
  const result = checkAndFixIos17Compat({ rootDir: process.cwd(), fix, checkPrebuild });

  if (result.changedFiles.length > 0) {
    console.log(`Updated iOS ${IOS_DEPLOYMENT_TARGET} compatibility in:`);
    for (const file of result.changedFiles) {
      console.log(`  - ${file}`);
    }
  }

  if (!result.ok) {
    console.error(`iOS ${IOS_DEPLOYMENT_TARGET} compatibility check failed:`);
    for (const issue of result.issues) {
      console.error(`  - ${issue}`);
    }
    process.exit(1);
  }

  console.log(
    `Verified iOS ${IOS_DEPLOYMENT_TARGET} compatibility across ${result.checkedFiles.length} file(s).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
