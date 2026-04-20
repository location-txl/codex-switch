import { describe, expect, it } from "vitest";

import {
  getCurrentProviderInfo,
  readCodexConfigText,
  removeManagedProviderConfig,
  setCurrentProviderToOpenAI,
  upsertManagedProviderConfig,
  writeCodexConfigText,
} from "../src/codex-config.js";

describe("codex-config", () => {
  it("只更新 model_provider 并保留其他内容", async () => {
    const home = tTempHome();
    await writeCodexConfigText(
      [
        'model = "gpt-5.4"',
        'model_provider = "me"',
        "",
        "[features]",
        "multi_agent = true",
        "",
      ].join("\n"),
      home,
    );

    await setCurrentProviderToOpenAI(home);
    const text = await readCodexConfigText(home);
    expect(text).toContain('model = "gpt-5.4"');
    expect(text).toContain('model_provider = "openai"');
    expect(text).toContain('cli_auth_credentials_store = "file"');
    expect(text).toContain("[features]");
  });

  it("新增托管 provider block 并保持幂等", async () => {
    const home = tTempHome();
    await writeCodexConfigText('model_provider = "openai"\n', home);

    await upsertManagedProviderConfig({ name: "proxy", baseUrl: "https://proxy.example.com/v1" }, home);
    await upsertManagedProviderConfig({ name: "proxy", baseUrl: "https://proxy.example.com/v1" }, home);

    const text = await readCodexConfigText(home);
    expect(text.match(/codex-switch:start:proxy/g)?.length).toBe(1);
    expect(text).toContain('[model_providers.proxy]');
    expect(text).not.toContain('[model_providers.proxy.auth]');
    expect(text).not.toContain('command = "codex-switch"');
    expect(text).not.toContain('args = ["token", "proxy"]');
  });

  it("删除托管 provider block 不影响用户自定义 block", async () => {
    const home = tTempHome();
    await writeCodexConfigText(
      [
        'model_provider = "openai"',
        "",
        "[model_providers.user_defined]",
        'base_url = "https://user.example.com/v1"',
        "",
      ].join("\n"),
      home,
    );

    await upsertManagedProviderConfig({ name: "proxy", baseUrl: "https://proxy.example.com/v1" }, home);
    await removeManagedProviderConfig("proxy", home);

    const text = await readCodexConfigText(home);
    expect(text).toContain("[model_providers.user_defined]");
    expect(text).not.toContain("codex-switch:start:proxy");
  });

  it("读取当前 provider 信息", async () => {
    const home = tTempHome();
    await writeCodexConfigText(
      [
        'model_provider = "proxy"',
        "",
        "# codex-switch:start:proxy",
        "[model_providers.proxy]",
        'base_url = "https://proxy.example.com/v1"',
        "# codex-switch:end:proxy",
      ].join("\n"),
      home,
    );

    const info = await getCurrentProviderInfo(home);
    expect(info.providerId).toBe("proxy");
    expect(info.baseUrl).toBe("https://proxy.example.com/v1");
    expect(info.authMode).toBe("auth.json");
    expect(info.managedByCodexSwitch).toBe(true);
  });
});

function tTempHome(): string {
  return `${process.env.TMPDIR || "/tmp"}/codex-switch-test-${crypto.randomUUID()}`;
}

import crypto from "node:crypto";
