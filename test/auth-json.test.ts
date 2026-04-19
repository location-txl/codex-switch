import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getLegacyApiKey, readAuthJson, writeChatgptAuthJson } from "../src/auth-json.js";
import { getCodexAuthPath } from "../src/utils.js";

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
});

function tempHome(): string {
  return `${process.env.TMPDIR || "/tmp"}/codex-switch-auth-${crypto.randomUUID()}`;
}

function createJwt(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}
