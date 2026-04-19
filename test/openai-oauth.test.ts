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

    const result = await obtainOpenAiApiKey(fetchMock, { idToken: "jwt" });
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

    const device = await requestDeviceCode(fetchMock, {});
    expect(device.userCode).toBe("ABCD-1234");

    const auth = await pollDeviceCodeAuthorization(fetchMock, {
      deviceAuthId: device.deviceAuthId,
      userCode: device.userCode,
      intervalSec: 0,
      timeoutMs: 100,
      sleepFn: async () => {},
    });

    expect(auth.authorizationCode).toBe("code");
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
