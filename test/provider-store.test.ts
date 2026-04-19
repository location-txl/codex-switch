import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { getProvider, listProviders, removeProvider, upsertProvider } from "../src/provider-store.js";

describe("provider-store", () => {
  it("支持新增与读取 provider", async () => {
    const home = tempHome();
    await upsertProvider({
      name: "demo",
      baseUrl: "https://demo.example.com/v1",
      sk: "sk-demo",
    }, home);

    const item = await getProvider("demo", home);
    expect(item?.name).toBe("demo");
    expect(item?.baseUrl).toBe("https://demo.example.com/v1");
  });

  it("支持更新 provider", async () => {
    const home = tempHome();
    await upsertProvider({
      name: "demo",
      baseUrl: "https://one.example.com/v1",
      sk: "sk-one",
    }, home);
    await upsertProvider({
      name: "demo",
      baseUrl: "https://two.example.com/v1",
      sk: "sk-two",
    }, home);

    const item = await getProvider("demo", home);
    expect(item?.baseUrl).toBe("https://two.example.com/v1");
    expect(item?.sk).toBe("sk-two");
  });

  it("支持删除 provider", async () => {
    const home = tempHome();
    await upsertProvider({
      name: "demo",
      baseUrl: "https://demo.example.com/v1",
      sk: "sk-demo",
    }, home);

    expect((await listProviders(home)).length).toBe(1);
    expect(await removeProvider("demo", home)).toBe(true);
    expect((await listProviders(home)).length).toBe(0);
  });
});

function tempHome(): string {
  return `${process.env.TMPDIR || "/tmp"}/codex-switch-store-${crypto.randomUUID()}`;
}
