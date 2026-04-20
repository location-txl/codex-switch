import crypto from "node:crypto";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { writeSwitchChatgptAuthJson } from "../src/auth-json.js";
import { readCodexConfigText, writeCodexConfigText } from "../src/codex-config.js";
import { getProvider, upsertProvider } from "../src/provider-store.js";
import { getCodexAuthPath } from "../src/utils.js";

describe("cli", () => {
  it("无参数时显示帮助而不是报错", async () => {
    const output = await captureStdout(() => main([]));

    expect(output).toContain("codex-switch <command> [options]");
    expect(output).toContain("codex-switch current");
  });

  it("yargs 支持 --base-url=... 内联参数值", async () => {
    const { codexHome, restoreEnv } = prepareHomes();
    try {
      await main(["add", "inline", "--base-url=https://example.com/v1", "--sk", "sk-inline", "--codex-home", codexHome]);

      const provider = await getProvider("inline");
      expect(provider?.baseUrl).toBe("https://example.com/v1");
      expect(provider?.sk).toBe("sk-inline");
    } finally {
      restoreEnv();
    }
  });

  it("yargs 支持全局参数放在命令前且 --base-url 后接参数值", async () => {
    const { codexHome, restoreEnv } = prepareHomes();
    try {
      await main(["--codex-home", codexHome, "add", "spaced", "--base-url", "https://example.com/v1", "--sk", "sk-spaced"]);

      const provider = await getProvider("spaced");
      expect(provider?.baseUrl).toBe("https://example.com/v1");
      expect(provider?.sk).toBe("sk-spaced");
    } finally {
      restoreEnv();
    }
  });

  it("非交互环境 add 缺少必填参数时直接失败", async () => {
    const { codexHome, restoreEnv } = prepareHomes();
    const restoreStdinTty = setStdinTty(false);
    try {
      await expect(main(["add", "missing-base-url", "--sk", "sk-demo", "--codex-home", codexHome]))
        .rejects
        .toThrow("缺少必填参数：--base-url");

      const provider = await getProvider("missing-base-url");
      expect(provider).toBeNull();
    } finally {
      restoreStdinTty();
      restoreEnv();
    }
  });

  it("无 OpenAI 登录态时也能切换第三方 provider", async () => {
    const { codexHome, switchHome, restoreEnv } = prepareHomes();
    try {
      await writeCodexConfigText('model_provider = "openai"\n', codexHome);
      await upsertProvider({
        name: "demo",
        baseUrl: "https://demo.example.com/v1",
        sk: "sk-demo",
      }, switchHome);

      await main(["use", "demo", "--codex-home", codexHome]);
      const config = await readCodexConfigText(codexHome);
      expect(config).toContain('model_provider = "demo"');
      expect(config).not.toContain('[model_providers.demo.auth]');
      expect(config).not.toContain('command = "codex-switch"');
      expect(config).not.toContain('args = ["token", "demo"]');

      const runtimeAuth = JSON.parse(await fs.readFile(getCodexAuthPath(codexHome), "utf8")) as {
        OPENAI_API_KEY?: string;
      };
      expect(runtimeAuth.OPENAI_API_KEY).toBe("sk-demo");
    } finally {
      restoreEnv();
    }
  });

  it("OpenAI 登录态刷新失败不阻塞第三方切换", async () => {
    const { codexHome, switchHome, restoreEnv } = prepareHomes();
    try {
      await writeCodexConfigText('model_provider = "openai"\n', codexHome);
      await upsertProvider({
        name: "demo",
        baseUrl: "https://demo.example.com/v1",
        sk: "sk-demo",
      }, switchHome);
      await writeSwitchChatgptAuthJson({
        idToken: createJwt({}),
        accessToken: "access-old",
        refreshToken: "refresh-old",
      }, switchHome);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response("", { status: 500 });
      try {
        await main(["use", "demo", "--codex-home", codexHome]);
      } finally {
        globalThis.fetch = originalFetch;
      }

      const config = await readCodexConfigText(codexHome);
      expect(config).toContain('model_provider = "demo"');
      const runtimeAuth = JSON.parse(await fs.readFile(getCodexAuthPath(codexHome), "utf8")) as {
        OPENAI_API_KEY?: string;
      };
      expect(runtimeAuth.OPENAI_API_KEY).toBe("sk-demo");
    } finally {
      restoreEnv();
    }
  });

  it("切回 openai 前先刷新 switch store，避免写回旧 runtime token", async () => {
    const { codexHome, switchHome, restoreEnv } = prepareHomes();
    try {
      await writeCodexConfigText('model_provider = "demo"\n', codexHome);
      await writeSwitchChatgptAuthJson({
        issuer: "https://issuer.example.com",
        clientId: "client-1",
        idToken: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct_old",
            organization_id: "org_old",
          },
        }),
        accessToken: "access-old",
        refreshToken: "refresh-old",
        openaiApiKey: "sk-old",
      }, switchHome);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body;
        if (!(body instanceof URLSearchParams)) {
          throw new Error("unexpected body");
        }
        if (body.get("grant_type") === "refresh_token") {
          return responseJson({
            id_token: createJwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct_new",
                organization_id: "org_123",
              },
            }),
            access_token: "access-new",
            refresh_token: "refresh-new",
          });
        }
        if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange") {
          return responseJson({ access_token: "sk-new" });
        }
        throw new Error("unexpected grant_type");
      };

      try {
        await main(["use", "openai", "--codex-home", codexHome]);
      } finally {
        globalThis.fetch = originalFetch;
      }

      const runtimeAuth = JSON.parse(await fs.readFile(getCodexAuthPath(codexHome), "utf8")) as {
        tokens?: {
          refresh_token?: string;
        };
        openai_api_key?: string;
      };
      expect(runtimeAuth.tokens?.refresh_token).toBe("refresh-new");
      expect(runtimeAuth.openai_api_key).toBe("sk-new");
    } finally {
      restoreEnv();
    }
  });
});

function prepareHomes(): { codexHome: string; switchHome: string; restoreEnv: () => void } {
  const originalCodexHome = process.env.CODEX_HOME;
  const originalSwitchHome = process.env.CODEX_SWITCH_HOME;
  const codexHome = `${process.env.TMPDIR || "/tmp"}/codex-switch-cli-codex-${crypto.randomUUID()}`;
  const switchHome = `${process.env.TMPDIR || "/tmp"}/codex-switch-cli-switch-${crypto.randomUUID()}`;
  process.env.CODEX_SWITCH_HOME = switchHome;
  return {
    codexHome,
    switchHome,
    restoreEnv: () => {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      if (originalSwitchHome === undefined) {
        delete process.env.CODEX_SWITCH_HOME;
      } else {
        process.env.CODEX_SWITCH_HOME = originalSwitchHome;
      }
    },
  };
}

function setStdinTty(value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(process.stdin, "isTTY", descriptor);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (typeof encodingOrCallback === "function") {
      encodingOrCallback();
    }
    if (callback) {
      callback();
    }
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return chunks.join("");
}

function responseJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createJwt(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}
