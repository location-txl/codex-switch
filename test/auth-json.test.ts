import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  getLegacyApiKey,
  persistOpenAiAuth,
  readAuthJson,
  readSwitchAuthJson,
  syncSwitchAuthToCodex,
  writeChatgptAuthJson,
  writeRuntimeLegacyApiKeyAuthJson,
  writeSwitchChatgptAuthJson,
} from "../src/auth-json.js";
import { getCodexAuthPath, getSwitchAuthPath } from "../src/utils.js";

describe("auth-json", () => {
  it("兼容 legacy OPENAI_API_KEY 结构", async () => {
    const home = tempHome();
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(getCodexAuthPath(home), JSON.stringify({ OPENAI_API_KEY: "sk-legacy" }));

    const auth = await readAuthJson(home);
    expect(getLegacyApiKey(auth)).toBe("sk-legacy");
  });

  it("写入 chatgpt auth.json", async () => {
    const home = tempHome();
    const idToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });

    await writeChatgptAuthJson(
      {
        idToken,
        accessToken: "acc",
        refreshToken: "ref",
        openaiApiKey: "sk-openai",
      },
      home,
    );

    const raw = await fs.readFile(path.join(home, "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as { auth_mode: string; tokens: { account_id: string } };
    expect(parsed.auth_mode).toBe("chatgpt");
    expect(parsed.tokens.account_id).toBe("acct_123");
  });

  it("写入第三方 provider 使用的 runtime OPENAI_API_KEY", async () => {
    const codexHome = tempHome();
    const switchHome = tempHome();

    await writeRuntimeLegacyApiKeyAuthJson("sk-third-party", codexHome);

    const runtimeAuth = JSON.parse(await fs.readFile(getCodexAuthPath(codexHome), "utf8")) as {
      OPENAI_API_KEY?: string;
    };
    expect(runtimeAuth.OPENAI_API_KEY).toBe("sk-third-party");
    await expect(fs.access(getSwitchAuthPath(switchHome))).rejects.toThrow();
  });

  it("OpenAI 登录态同时写入 switch store 与 runtime auth", async () => {
    const codexHome = tempHome();
    const switchHome = tempHome();
    const idToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });

    await persistOpenAiAuth(
      {
        issuer: "https://issuer.example.com",
        clientId: "client-1",
        idToken,
        accessToken: "acc",
        refreshToken: "ref",
        openaiApiKey: "sk-openai",
      },
      codexHome,
      switchHome,
    );

    const switchRaw = await fs.readFile(getSwitchAuthPath(switchHome), "utf8");
    const runtimeRaw = await fs.readFile(getCodexAuthPath(codexHome), "utf8");
    const switchParsed = JSON.parse(switchRaw) as { issuer: string; client_id: string };
    const runtimeParsed = JSON.parse(runtimeRaw) as { issuer: string; client_id: string };
    expect(switchParsed.issuer).toBe("https://issuer.example.com");
    expect(switchParsed.client_id).toBe("client-1");
    expect(runtimeParsed.issuer).toBe("https://issuer.example.com");
    expect(runtimeParsed.client_id).toBe("client-1");
  });

  it("可以从 switch store 同步 OpenAI 登录态到 runtime auth", async () => {
    const codexHome = tempHome();
    const switchHome = tempHome();
    const idToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });

    await writeSwitchChatgptAuthJson(
      {
        issuer: "https://issuer.example.com",
        clientId: "client-1",
        idToken,
        accessToken: "acc",
        refreshToken: "ref",
        openaiApiKey: "sk-openai",
      },
      switchHome,
    );

    expect(await syncSwitchAuthToCodex(codexHome, switchHome)).not.toBeNull();
    const auth = await readAuthJson(codexHome);
    const switchAuth = await readSwitchAuthJson(switchHome);
    expect(auth && "openai_api_key" in auth ? auth.openai_api_key : null).toBe("sk-openai");
    expect(switchAuth && "issuer" in switchAuth ? switchAuth.issuer : null).toBe("https://issuer.example.com");
  });

  it("id_token 缺少 account_id 时回退使用 access_token", async () => {
    const home = tempHome();
    const idToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
      },
    });
    const accessToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_access",
      },
    });

    await writeChatgptAuthJson(
      {
        idToken,
        accessToken,
        refreshToken: "ref",
      },
      home,
    );

    const raw = await fs.readFile(path.join(home, "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as { tokens: { account_id: string } };
    expect(parsed.tokens.account_id).toBe("acct_from_access");
  });
});

function tempHome(): string {
  return `${process.env.TMPDIR || "/tmp"}/codex-switch-auth-${crypto.randomUUID()}`;
}

function createJwt(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}
