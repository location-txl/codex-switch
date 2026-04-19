import crypto from "node:crypto";
import http from "node:http";
import { URL, URLSearchParams } from "node:url";
import { spawn } from "node:child_process";

import {
  DEFAULT_OPENAI_CALLBACK_PORT,
  DEFAULT_OPENAI_CLIENT_ID,
  DEFAULT_OPENAI_ISSUER,
  DEVICE_CODE_TIMEOUT_MS,
  DEVICE_POLL_DEFAULT_INTERVAL_SEC,
} from "./constants.js";
import { writeChatgptAuthJson } from "./auth-json.js";
import { base64UrlEncode, sleep } from "./utils.js";

export interface OAuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  openaiApiKey?: string | null;
}

export interface OpenAiOAuthOptions {
  issuer?: string;
  clientId?: string;
  callbackPort?: number;
  codexHome?: string;
  openBrowser?: boolean;
}

export interface DeviceCodePrompt {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSec: number;
}

export interface DeviceCodeAuthorization {
  authorizationCode: string;
  codeChallenge: string;
  codeVerifier: string;
}

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

export function buildAuthorizeUrl(input: {
  issuer?: string;
  clientId?: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const issuer = input.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = input.clientId || DEFAULT_OPENAI_CLIENT_ID;
  const url = new URL("/oauth/authorize", issuer);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set(
    "scope",
    "openid profile email offline_access api.connectors.read api.connectors.invoke",
  );
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function parseBrowserCallback(callbackUrl: string, expectedState: string): { code: string } {
  const url = new URL(callbackUrl, "http://localhost");
  const state = url.searchParams.get("state");
  if (state !== expectedState) {
    throw new Error("OAuth state 校验失败");
  }

  const errorCode = url.searchParams.get("error");
  if (errorCode) {
    const description = url.searchParams.get("error_description");
    throw new Error(description ? `登录失败：${description}` : `登录失败：${errorCode}`);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("回调缺少 authorization code");
  }
  return { code };
}

export async function exchangeCodeForTokens(
  fetchImpl: FetchLike,
  input: {
    issuer?: string;
    clientId?: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  },
): Promise<Omit<OAuthTokens, "openaiApiKey">> {
  const issuer = input.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = input.clientId || DEFAULT_OPENAI_CLIENT_ID;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: clientId,
    code_verifier: input.codeVerifier,
  });

  const response = await fetchImpl(new URL("/oauth/token", issuer), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`token exchange 失败：HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
  };

  if (!data.id_token || !data.access_token || !data.refresh_token) {
    throw new Error("token exchange 返回了不完整的 token");
  }

  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

export async function obtainOpenAiApiKey(
  fetchImpl: FetchLike,
  input: { issuer?: string; clientId?: string; idToken: string },
): Promise<string> {
  const issuer = input.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = input.clientId || DEFAULT_OPENAI_CLIENT_ID;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: clientId,
    requested_token: "openai-api-key",
    subject_token: input.idToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
  });

  const response = await fetchImpl(new URL("/oauth/token", issuer), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`API key exchange 失败：HTTP ${response.status}`);
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("API key exchange 未返回 access_token");
  }
  return data.access_token;
}

export async function requestDeviceCode(
  fetchImpl: FetchLike,
  input: { issuer?: string; clientId?: string },
): Promise<DeviceCodePrompt> {
  const issuer = input.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = input.clientId || DEFAULT_OPENAI_CLIENT_ID;
  const response = await fetchImpl(new URL("/api/accounts/deviceauth/usercode", issuer), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ client_id: clientId }),
  });

  if (!response.ok) {
    throw new Error(`device code 请求失败：HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    usercode?: string;
    interval?: string | number;
  };

  if (!data.device_auth_id || (!data.user_code && !data.usercode)) {
    throw new Error("device code 响应不完整");
  }

  const intervalRaw = data.interval ?? DEVICE_POLL_DEFAULT_INTERVAL_SEC;
  const intervalSec =
    typeof intervalRaw === "number" ? intervalRaw : Number.parseInt(String(intervalRaw), 10);

  return {
    verificationUrl: new URL("/codex/device", issuer).toString(),
    userCode: data.user_code || data.usercode!,
    deviceAuthId: data.device_auth_id,
    intervalSec: Number.isFinite(intervalSec) && intervalSec > 0
      ? intervalSec
      : DEVICE_POLL_DEFAULT_INTERVAL_SEC,
  };
}

export async function pollDeviceCodeAuthorization(
  fetchImpl: FetchLike,
  input: {
    issuer?: string;
    deviceAuthId: string;
    userCode: string;
    intervalSec: number;
    timeoutMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<DeviceCodeAuthorization> {
  const issuer = input.issuer || DEFAULT_OPENAI_ISSUER;
  const timeoutMs = input.timeoutMs ?? DEVICE_CODE_TIMEOUT_MS;
  const sleepFn = input.sleepFn ?? sleep;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetchImpl(new URL("/api/accounts/deviceauth/token", issuer), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_auth_id: input.deviceAuthId,
        user_code: input.userCode,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        authorization_code?: string;
        code_challenge?: string;
        code_verifier?: string;
      };

      if (!data.authorization_code || !data.code_challenge || !data.code_verifier) {
        throw new Error("device code token 响应不完整");
      }

      return {
        authorizationCode: data.authorization_code,
        codeChallenge: data.code_challenge,
        codeVerifier: data.code_verifier,
      };
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`device code 轮询失败：HTTP ${response.status}`);
    }

    await sleepFn(input.intervalSec * 1000);
  }

  throw new Error("device code 登录超时（15 分钟）");
}

async function openInBrowser(url: string): Promise<boolean> {
  const commands: Array<{ command: string; args: string[] }> =
    process.platform === "darwin"
      ? [{ command: "open", args: [url] }]
      : process.platform === "win32"
        ? [{ command: "cmd", args: ["/c", "start", "", url] }]
        : [{ command: "xdg-open", args: [url] }];

  for (const item of commands) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(item.command, item.args, {
          stdio: "ignore",
          detached: false,
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`${item.command} exit ${code}`));
        });
      });
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

async function startOAuthCallbackServer(
  input: {
    issuer?: string;
    clientId?: string;
    callbackPort?: number;
    openBrowser?: boolean;
  },
): Promise<{ code: string; redirectUri: string }> {
  const issuer = input.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = input.clientId || DEFAULT_OPENAI_CLIENT_ID;
  const callbackPort = input.callbackPort ?? DEFAULT_OPENAI_CALLBACK_PORT;
  const pkce = createPkcePair();
  const state = createState();

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("无法启动本地 OAuth 回调服务");
  }

  const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
  const authUrl = buildAuthorizeUrl({
    issuer,
    clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
    state,
  });

  if (input.openBrowser !== false) {
    const opened = await openInBrowser(authUrl);
    if (!opened) {
      process.stderr.write(`无法自动打开浏览器，请手动访问：${authUrl}\n`);
    }
  } else {
    process.stderr.write(`请在浏览器打开：${authUrl}\n`);
  }

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const requestUrl = req.url || "/";
      try {
        const parsed = parseBrowserCallback(requestUrl, state);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<html><body><h1>登录成功</h1><p>可以关闭这个页面了。</p></body></html>");
        resolve(parsed.code);
      } catch (error) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<html><body><h1>登录失败</h1><p>${String((error as Error).message)}</p></body></html>`,
        );
        reject(error);
      } finally {
        server.close();
      }
    });
  });

  const tokens = await exchangeCodeForTokens(fetch, {
    issuer,
    clientId,
    redirectUri,
    code,
    codeVerifier: pkce.verifier,
  });

  let openaiApiKey: string | null = null;
  try {
    openaiApiKey = await obtainOpenAiApiKey(fetch, {
      issuer,
      clientId,
      idToken: tokens.idToken,
    });
  } catch {
    openaiApiKey = null;
  }

  await writeChatgptAuthJson(
    {
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      openaiApiKey,
    },
    undefined,
  );

  return { code, redirectUri };
}

export async function runOpenAiBrowserLogin(options: OpenAiOAuthOptions = {}): Promise<OAuthTokens> {
  const issuer = options.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = options.clientId || DEFAULT_OPENAI_CLIENT_ID;
  const callbackPort = options.callbackPort ?? DEFAULT_OPENAI_CALLBACK_PORT;
  const pkce = createPkcePair();
  const state = createState();

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("无法启动本地 OAuth 回调服务");
  }

  const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
  const authUrl = buildAuthorizeUrl({
    issuer,
    clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
    state,
  });

  if (options.openBrowser !== false) {
    const opened = await openInBrowser(authUrl);
    if (!opened) {
      process.stderr.write(`无法自动打开浏览器，请手动访问：${authUrl}\n`);
    }
  } else {
    process.stderr.write(`请在浏览器打开：${authUrl}\n`);
  }

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const requestUrl = req.url || "/";
      try {
        const parsed = parseBrowserCallback(requestUrl, state);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<html><body><h1>登录成功</h1><p>可以关闭这个页面了。</p></body></html>");
        resolve(parsed.code);
      } catch (error) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<html><body><h1>登录失败</h1><p>${String((error as Error).message)}</p></body></html>`,
        );
        reject(error);
      } finally {
        server.close();
      }
    });
  });

  const tokens = await exchangeCodeForTokens(fetch, {
    issuer,
    clientId,
    redirectUri,
    code,
    codeVerifier: pkce.verifier,
  });

  let openaiApiKey: string | null = null;
  try {
    openaiApiKey = await obtainOpenAiApiKey(fetch, {
      issuer,
      clientId,
      idToken: tokens.idToken,
    });
  } catch {
    openaiApiKey = null;
  }

  const result: OAuthTokens = { ...tokens, openaiApiKey };
  await writeChatgptAuthJson(
    {
      idToken: result.idToken,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      openaiApiKey: result.openaiApiKey,
    },
    options.codexHome,
  );
  return result;
}

export async function runOpenAiDeviceLogin(options: OpenAiOAuthOptions = {}): Promise<OAuthTokens> {
  const issuer = options.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = options.clientId || DEFAULT_OPENAI_CLIENT_ID;

  const prompt = await requestDeviceCode(fetch, { issuer, clientId });
  process.stderr.write(
    `请打开链接并输入验证码：\n${prompt.verificationUrl}\n验证码：${prompt.userCode}\n`,
  );

  const auth = await pollDeviceCodeAuthorization(fetch, {
    issuer,
    deviceAuthId: prompt.deviceAuthId,
    userCode: prompt.userCode,
    intervalSec: prompt.intervalSec,
  });

  const redirectUri = new URL("/deviceauth/callback", issuer).toString();
  const tokens = await exchangeCodeForTokens(fetch, {
    issuer,
    clientId,
    redirectUri,
    code: auth.authorizationCode,
    codeVerifier: auth.codeVerifier,
  });

  let openaiApiKey: string | null = null;
  try {
    openaiApiKey = await obtainOpenAiApiKey(fetch, {
      issuer,
      clientId,
      idToken: tokens.idToken,
    });
  } catch {
    openaiApiKey = null;
  }

  const result: OAuthTokens = { ...tokens, openaiApiKey };
  await writeChatgptAuthJson(
    {
      idToken: result.idToken,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      openaiApiKey: result.openaiApiKey,
    },
    options.codexHome,
  );
  return result;
}
