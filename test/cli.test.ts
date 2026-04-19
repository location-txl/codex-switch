import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/cli.js";

describe("cli", () => {
  it("支持全局 --debug 放在命令前", () => {
    const parsed = parseArgs(["--debug", "login", "openai"]);
    expect(parsed.positionals).toEqual(["login", "openai"]);
    expect(parsed.flags.get("--debug")).toBe(true);
  });

  it("支持 --debug 放在命令后", () => {
    const parsed = parseArgs(["login", "openai", "--debug"]);
    expect(parsed.positionals).toEqual(["login", "openai"]);
    expect(parsed.flags.get("--debug")).toBe(true);
  });
});
