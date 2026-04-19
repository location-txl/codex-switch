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
import { base64UrlEncode, getNestedRecord, parseJwtClaims, sleep } from "./utils.js";

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
  debug?: boolean;
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

function debugLog(enabled: boolean | undefined, message: string): void {
  if (!enabled) {
    return;
  }
  process.stderr.write(`[debug] ${message}\n`);
}

function maskSecretValue(value: string): string {
  if (value.length <= 8) {
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function sanitizeKeyValue(key: string, value: string): string {
  const normalizedKey = key.toLowerCase();
  if (
    normalizedKey.includes("token")
    || normalizedKey.includes("authorization")
    || normalizedKey === "code"
    || normalizedKey === "code_verifier"
    || normalizedKey === "code_challenge"
    || normalizedKey.includes("api_key")
    || normalizedKey.includes("secret")
  ) {
    return maskSecretValue(value);
  }
  return value;
}

function describeUrlEncodedBody(body: URLSearchParams): string {
  return Array.from(body.entries())
    .map(([key, value]) => `${key}=${sanitizeKeyValue(key, value)}`)
    .join("&");
}

async function debugFetch(
  fetchImpl: FetchLike,
  enabled: boolean | undefined,
  input: string | URL,
  init: RequestInit,
  label: string,
): Promise<Response> {
  debugLog(enabled, `${label} 请求 ${init.method || "GET"} ${String(input)}`);

  if (init.body instanceof URLSearchParams) {
    debugLog(enabled, `${label} 请求体 ${describeUrlEncodedBody(init.body)}`);
  } else if (typeof init.body === "string" && init.body.length > 0) {
    try {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      const sanitized = Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [
          key,
          typeof value === "string" ? sanitizeKeyValue(key, value) : value,
        ]),
      );
      debugLog(enabled, `${label} 请求体 ${JSON.stringify(sanitized)}`);
    } catch {
      debugLog(enabled, `${label} 请求体 <non-json-body>`);
    }
  }

  const response = await fetchImpl(input, init);
  debugLog(enabled, `${label} 响应状态 HTTP ${response.status}`);

  if (enabled) {
    const cloned = response.clone();
    const contentType = cloned.headers.get("content-type") || "";
    const rawBody = await cloned.text();
    if (rawBody) {
      let sanitizedBody = rawBody;
      if (contentType.includes("application/json")) {
        try {
          const parsed = JSON.parse(rawBody) as Record<string, unknown>;
          sanitizedBody = JSON.stringify(
            Object.fromEntries(
              Object.entries(parsed).map(([key, value]) => [
                key,
                typeof value === "string" ? sanitizeKeyValue(key, value) : value,
              ]),
            ),
          );
        } catch {
          sanitizedBody = rawBody;
        }
      }
      debugLog(enabled, `${label} 响应体 ${sanitizedBody}`);
    }
  }

  return response;
}

function getIdTokenOrganizationId(idToken: string): string | null {
  const claims = parseJwtClaims(idToken);
  const authClaims = getNestedRecord(claims, "https://api.openai.com/auth");
  const organizationId = authClaims?.organization_id;
  return typeof organizationId === "string" && organizationId.length > 0 ? organizationId : null;
}

async function maybeObtainOpenAiApiKey(
  fetchImpl: FetchLike,
  input: { issuer?: string; clientId?: string; idToken: string; debug?: boolean },
): Promise<string | null> {
  const organizationId = getIdTokenOrganizationId(input.idToken);
  if (!organizationId) {
    debugLog(input.debug, "id_token 缺少 organization_id，跳过 openai api key exchange");
    return null;
  }

  try {
    return await obtainOpenAiApiKey(fetchImpl, input);
  } catch {
    debugLog(input.debug, "openai api key exchange 失败，继续仅写入 chatgpt token");
    return null;
  }
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

export function getBrowserOAuthRedirectUri(callbackPort: number = DEFAULT_OPENAI_CALLBACK_PORT): string {
  return `http://localhost:${callbackPort}/auth/callback`;
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
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
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
    debug?: boolean;
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

  const response = await debugFetch(fetchImpl, input.debug, new URL("/oauth/token", issuer), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  }, "token exchange");

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
  input: { issuer?: string; clientId?: string; idToken: string; debug?: boolean },
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

  const response = await debugFetch(fetchImpl, input.debug, new URL("/oauth/token", issuer), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  }, "api key exchange");

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
  input: { issuer?: string; clientId?: string; debug?: boolean },
): Promise<DeviceCodePrompt> {
  const issuer = input.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = input.clientId || DEFAULT_OPENAI_CLIENT_ID;
  const response = await debugFetch(fetchImpl, input.debug, new URL("/api/accounts/deviceauth/usercode", issuer), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ client_id: clientId }),
  }, "device code");

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
    debug?: boolean;
  },
): Promise<DeviceCodeAuthorization> {
  const issuer = input.issuer || DEFAULT_OPENAI_ISSUER;
  const timeoutMs = input.timeoutMs ?? DEVICE_CODE_TIMEOUT_MS;
  const sleepFn = input.sleepFn ?? sleep;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    debugLog(input.debug, `device code 轮询中 device_auth_id=${sanitizeKeyValue("device_auth_id", input.deviceAuthId)}`);
    const response = await debugFetch(fetchImpl, input.debug, new URL("/api/accounts/deviceauth/token", issuer), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_auth_id: input.deviceAuthId,
        user_code: input.userCode,
      }),
    }, "device token");

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

export async function startOAuthCallbackServer(
  input: {
    issuer?: string;
    clientId?: string;
    callbackPort?: number;
    openBrowser?: boolean;
    debug?: boolean;
  },
): Promise<{ code: string; redirectUri: string; codeVerifier: string }> {
  const issuer = input.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = input.clientId || DEFAULT_OPENAI_CLIENT_ID;
  const callbackPort = input.callbackPort ?? DEFAULT_OPENAI_CALLBACK_PORT;
  const pkce = createPkcePair();
  const state = createState();

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error & { code?: string }) => {
      server.off("error", onError);
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `OAuth 回调端口 ${callbackPort} 已被占用，请先关闭占用该端口的程序后重试`,
          ),
        );
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(callbackPort, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("无法启动本地 OAuth 回调服务");
  }

  const redirectUri = getBrowserOAuthRedirectUri(address.port);
  const authUrl = buildAuthorizeUrl({
    issuer,
    clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
    state,
  });

  debugLog(input.debug, `browser 登录启动 callback=${redirectUri}`);
  debugLog(input.debug, `browser 授权地址 ${authUrl}`);

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
        debugLog(input.debug, `收到 OAuth 回调 ${requestUrl}`);
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

  return { code, redirectUri, codeVerifier: pkce.verifier };
}

export async function runOpenAiBrowserLogin(
  options: OpenAiOAuthOptions = {},
  deps: {
    fetchImpl?: FetchLike;
    startCallbackServer?: typeof startOAuthCallbackServer;
    writeAuthJson?: typeof writeChatgptAuthJson;
  } = {},
): Promise<OAuthTokens> {
  debugLog(options.debug, "进入 browser 登录流程");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const startCallbackServer = deps.startCallbackServer ?? startOAuthCallbackServer;
  const writeAuthJson = deps.writeAuthJson ?? writeChatgptAuthJson;
  const { code, redirectUri, codeVerifier } = await startCallbackServer(options);
  const issuer = options.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = options.clientId || DEFAULT_OPENAI_CLIENT_ID;

  const tokens = await exchangeCodeForTokens(fetchImpl, {
    issuer,
    clientId,
    redirectUri,
    code,
    codeVerifier,
    debug: options.debug,
  });

  const openaiApiKey = await maybeObtainOpenAiApiKey(fetchImpl, {
    issuer,
    clientId,
    idToken: tokens.idToken,
    debug: options.debug,
  });

  const result: OAuthTokens = { ...tokens, openaiApiKey };
  await writeAuthJson(
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

export async function runOpenAiDeviceLogin(
  options: OpenAiOAuthOptions = {},
  deps: {
    fetchImpl?: FetchLike;
    writeAuthJson?: typeof writeChatgptAuthJson;
  } = {},
): Promise<OAuthTokens> {
  const issuer = options.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = options.clientId || DEFAULT_OPENAI_CLIENT_ID;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const writeAuthJson = deps.writeAuthJson ?? writeChatgptAuthJson;
  debugLog(options.debug, "进入 device 登录流程");

  const prompt = await requestDeviceCode(fetchImpl, { issuer, clientId, debug: options.debug });
  process.stderr.write(
    `请打开链接并输入验证码：\n${prompt.verificationUrl}\n验证码：${prompt.userCode}\n`,
  );

  const auth = await pollDeviceCodeAuthorization(fetchImpl, {
    issuer,
    deviceAuthId: prompt.deviceAuthId,
    userCode: prompt.userCode,
    intervalSec: prompt.intervalSec,
    debug: options.debug,
  });

  const redirectUri = new URL("/deviceauth/callback", issuer).toString();
  debugLog(options.debug, `device 登录使用 redirect_uri=${redirectUri}`);
  const tokens = await exchangeCodeForTokens(fetchImpl, {
    issuer,
    clientId,
    redirectUri,
    code: auth.authorizationCode,
    codeVerifier: auth.codeVerifier,
    debug: options.debug,
  });

  const openaiApiKey = await maybeObtainOpenAiApiKey(fetchImpl, {
    issuer,
    clientId,
    idToken: tokens.idToken,
    debug: options.debug,
  });

  const result: OAuthTokens = { ...tokens, openaiApiKey };
  await writeAuthJson(
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
