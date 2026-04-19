import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearConfiguredCodexHome,
  readConfiguredCodexHomeSync,
  writeConfiguredCodexHome,
} from "../src/app-config.js";

describe("app-config", () => {
  const originalHome = process.env.HOME;
  let fakeHome = "";

  beforeEach(async () => {
    fakeHome = path.join(os.tmpdir(), `codex-switch-home-${crypto.randomUUID()}`);
    await fs.mkdir(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it("可以设置并读取默认 Codex 目录", async () => {
    await writeConfiguredCodexHome("/tmp/codex-test-home");
    expect(readConfiguredCodexHomeSync()).toBe("/tmp/codex-test-home");
  });

  it("可以清除默认 Codex 目录", async () => {
    await writeConfiguredCodexHome("/tmp/codex-test-home");
    await clearConfiguredCodexHome();
    expect(readConfiguredCodexHomeSync()).toBeNull();
  });
});
