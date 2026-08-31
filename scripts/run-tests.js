#!/usr/bin/env node
// dshpkg — test driver: run every tests/*.test.js in its own FRESH
// `node --test` process, sequentially, inheriting stdio.
//
// Why not plain `node --test` (multi-file mode)? On this environment's
// Node v24.19 the multi-file runner corrupts its child IPC at a RANDOM
// file each run ("Unable to deserialize cloned data due to invalid or
// unsupported version"), failing files that always pass in isolation.
// A fresh runner per file avoids the accumulated-runner corruption
// (CONTRACTS.md R17). Zero third-party deps; spawnSync with shell:false.

import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(root, "tests");

const files = (await readdir(testsDir))
  .filter((name) => name.endsWith(".test.js"))
  .sort();

const failed = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--test", join(testsDir, file)], {
    stdio: "inherit",
    env: {
      ...process.env,
      // R19: apply() arms SIGINT/SIGTERM clean-shutdown listeners; the test
      // suites emit SYNTHETIC signals (process.emit) to stop supervisors, so
      // the guard must stay unregistered inside test processes.
      DSHPKG_NO_SIGNAL_GUARD: "off",
    },
    shell: false,
  });
  if (result.status !== 0) failed.push(file);
}

if (failed.length > 0) {
  console.error(`测试失败文件（${failed.length}）: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`全部 ${files.length} 个测试文件通过`);
