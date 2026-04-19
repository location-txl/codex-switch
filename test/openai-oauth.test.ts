import http from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  getBrowserOAuthRedirectUri,
  obtainOpenAiApiKey,
  parseBrowserCallback,
  pollDeviceCodeAuthorization,
  requestDeviceCode,
  runOpenAiBrowserLogin,
  startOAuthCallbackServer,
} from "../src/openai-oauth.js";

describe("openai-oauth", () => {
  it("authorize url 包含关键参数", () => {
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: "http://localhost:1455/auth/callback",
        codeChallenge: "challenge",
        state: "state",
      }),
    );

    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("state")).toBe("state");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
  });

  it("browser oauth 默认 redirect uri 使用 localhost:1455", () => {
    expect(getBrowserOAuthRedirectUri()).toBe("http://localhost:1455/auth/callback");
  });

  it("browser oauth 端口被占用时直接报错，不回退随机端口", async () => {
    const holder = http.createServer();
    const occupiedPort = await listen(holder, 0);

    await expect(
      startOAuthCallbackServer({
        callbackPort: occupiedPort,
        openBrowser: false,
      }),
    ).rejects.toThrow(`OAuth 回调端口 ${occupiedPort} 已被占用`);

    await closeServer(holder);
  });

  it("browser callback 缺 state 时失败", () => {
    expect(() => parseBrowserCallback("/auth/callback?code=abc&state=bad", "good")).toThrow(
      "OAuth state 校验失败",
    );
  });

  it("browser callback 缺 code 时失败", () => {
    expect(() => parseBrowserCallback("/auth/callback?state=ok", "ok")).toThrow(
      "回调缺少 authorization code",
    );
  });

  it("token exchange 请求体符合预期", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = String(init?.body);
      expect(body).toContain("grant_type=authorization_code");
      expect(body).toContain("client_id=");
      expect(body).toContain("code_verifier=verifier");
      return responseJson({
        id_token: "id",
        access_token: "access",
        refresh_token: "refresh",
      });
    });

    const result = await exchangeCodeForTokens(fetchMock, {
      redirectUri: "http://127.0.0.1/callback",
      code: "auth-code",
      codeVerifier: "verifier",
      debug: true,
    });

    expect(result.idToken).toBe("id");
  });

  it("API key exchange 请求体符合官方行为", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = String(init?.body);
      expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange");
      expect(body).toContain("requested_token=openai-api-key");
      expect(body).toContain("subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token");
      return responseJson({ access_token: "sk-test" });
    });

    const result = await obtainOpenAiApiKey(fetchMock, { idToken: "jwt", debug: true });
    expect(result).toBe("sk-test");
  });

  it("device code 请求与轮询正常", async () => {
    const fetchMock = vi
      .fn<Parameters<typeof requestDeviceCode>[0]>()
      .mockResolvedValueOnce(
        responseJson({
          device_auth_id: "dev-1",
          user_code: "ABCD-1234",
          interval: "1",
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(
        responseJson({
          authorization_code: "code",
          code_challenge: "challenge",
          code_verifier: "verifier",
        }),
      );

    const device = await requestDeviceCode(fetchMock, { debug: true });
    expect(device.userCode).toBe("ABCD-1234");

    const auth = await pollDeviceCodeAuthorization(fetchMock, {
      deviceAuthId: device.deviceAuthId,
      userCode: device.userCode,
      intervalSec: 0,
      timeoutMs: 100,
      sleepFn: async () => {},
      debug: true,
    });

    expect(auth.authorizationCode).toBe("code");
  });

  it("browser 登录只执行一次 authorization_code token exchange", async () => {
    const idToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = init?.body;
      if (!(body instanceof URLSearchParams)) {
        throw new Error("unexpected body");
      }
      if (body.get("grant_type") === "authorization_code") {
        return responseJson({
          id_token: idToken,
          access_token: "access-token",
          refresh_token: "refresh-token",
        });
      }
      throw new Error("unexpected grant_type");
    });

    const startCallbackServer = vi.fn(async () => ({
      code: "auth-code",
      redirectUri: "http://localhost:1455/auth/callback",
      codeVerifier: "verifier",
    }));
    const writeAuthJson = vi.fn(async () => ({
      auth_mode: "chatgpt" as const,
      openai_api_key: "sk-openai",
      tokens: null,
      last_refresh: null,
      agent_identity: null,
    }));

    const result = await runOpenAiBrowserLogin(
      { debug: true, codexHome: "/tmp/codex-home" },
      { fetchImpl: fetchMock, startCallbackServer, writeAuthJson },
    );

    expect(result.openaiApiKey).toBeNull();
    const authorizationCodeCalls = fetchMock.mock.calls.filter(([, init]) => {
      const body = init?.body;
      return body instanceof URLSearchParams && body.get("grant_type") === "authorization_code";
    });
    expect(authorizationCodeCalls).toHaveLength(1);
    const apiKeyExchangeCalls = fetchMock.mock.calls.filter(([, init]) => {
      const body = init?.body;
      return body instanceof URLSearchParams && body.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange";
    });
    expect(apiKeyExchangeCalls).toHaveLength(0);
    expect(startCallbackServer).toHaveBeenCalledTimes(1);
    expect(writeAuthJson).toHaveBeenCalledTimes(1);
  });

  it("id_token 带 organization_id 时才尝试 api key exchange", async () => {
    const idToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
        organization_id: "org_123",
      },
    });
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = init?.body;
      if (!(body instanceof URLSearchParams)) {
        throw new Error("unexpected body");
      }
      if (body.get("grant_type") === "authorization_code") {
        return responseJson({
          id_token: idToken,
          access_token: "access-token",
          refresh_token: "refresh-token",
        });
      }
      if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange") {
        return responseJson({ access_token: "sk-openai" });
      }
      throw new Error("unexpected grant_type");
    });

    const result = await runOpenAiBrowserLogin(
      { debug: true },
      {
        fetchImpl: fetchMock,
        startCallbackServer: vi.fn(async () => ({
          code: "auth-code",
          redirectUri: "http://localhost:1455/auth/callback",
          codeVerifier: "verifier",
        })),
        writeAuthJson: vi.fn(async () => ({
          auth_mode: "chatgpt" as const,
          openai_api_key: "sk-openai",
          tokens: null,
          last_refresh: null,
          agent_identity: null,
        })),
      },
    );

    expect(result.openaiApiKey).toBe("sk-openai");
    const apiKeyExchangeCalls = fetchMock.mock.calls.filter(([, init]) => {
      const body = init?.body;
      return body instanceof URLSearchParams && body.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange";
    });
    expect(apiKeyExchangeCalls).toHaveLength(1);
  });

  it("debug 日志会脱敏敏感字段", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await exchangeCodeForTokens(
      vi.fn(async () => responseJson({
        id_token: "id-token",
        access_token: "access-token",
        refresh_token: "refresh-token",
      })),
      {
        redirectUri: "http://127.0.0.1/callback",
        code: "very-secret-code",
        codeVerifier: "super-secret-verifier",
        debug: true,
      },
    );

    const logText = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(logText).toContain("[debug]");
    expect(logText).toContain("token exchange 响应状态 HTTP 200");
    expect(logText).not.toContain("very-secret-code");
    expect(logText).not.toContain("super-secret-verifier");
    expect(logText).not.toContain("access-token");

    stderrSpy.mockRestore();
  });
});

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

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("无法获取监听端口"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
