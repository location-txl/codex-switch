import {
  atomicWriteFile,
  getCodexAuthPath,
  getSwitchAuthPath,
  getNestedRecord,
  parseJwtClaims,
  readFileIfExists,
} from "./utils.js";

export interface LegacyApiKeyAuthJson {
  OPENAI_API_KEY?: string;
}

export interface ChatgptTokenBundle {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string | null;
}

export interface ChatgptAuthJson {
  auth_mode?: string | null;
  issuer?: string | null;
  client_id?: string | null;
  openai_api_key?: string | null;
  tokens?: ChatgptTokenBundle | null;
  last_refresh?: string | null;
  agent_identity?: unknown;
}

export type AuthJson = LegacyApiKeyAuthJson | ChatgptAuthJson;

async function readJsonFile(filePath: string): Promise<AuthJson | null> {
  const raw = await readFileIfExists(filePath);
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as AuthJson;
}

export async function readAuthJson(codexHome?: string): Promise<AuthJson | null> {
  const authPath = getCodexAuthPath(codexHome);
  return readJsonFile(authPath);
}

export async function readSwitchAuthJson(switchHome?: string): Promise<AuthJson | null> {
  return readJsonFile(getSwitchAuthPath(switchHome));
}

export function getLegacyApiKey(auth: AuthJson | null): string | null {
  if (!auth || typeof auth !== "object") {
    return null;
  }
  const value = (auth as LegacyApiKeyAuthJson).OPENAI_API_KEY;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getChatgptAccountIdFromJwt(jwt: string): string | null {
  const claims = parseJwtClaims(jwt);
  const authClaims = getNestedRecord(claims, "https://api.openai.com/auth");
  const accountId = authClaims?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function buildChatgptAuthJson(
  input: {
    issuer?: string | null;
    clientId?: string | null;
    idToken: string;
    accessToken: string;
    refreshToken: string;
    openaiApiKey?: string | null;
  },
): ChatgptAuthJson {
  const accountId = getChatgptAccountIdFromJwt(input.idToken) ||
    getChatgptAccountIdFromJwt(input.accessToken);

  return {
    auth_mode: "chatgpt",
    issuer: input.issuer ?? null,
    client_id: input.clientId ?? null,
    openai_api_key: input.openaiApiKey ?? null,
    tokens: {
      id_token: input.idToken,
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
    agent_identity: null,
  };
}

export async function writeSwitchChatgptAuthJson(
  input: {
    issuer?: string | null;
    clientId?: string | null;
    idToken: string;
    accessToken: string;
    refreshToken: string;
    openaiApiKey?: string | null;
  },
  switchHome?: string,
): Promise<ChatgptAuthJson> {
  const next = buildChatgptAuthJson(input);
  const authPath = getSwitchAuthPath(switchHome);
  await atomicWriteFile(authPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
}

export async function writeRuntimeChatgptAuthJson(
  input: {
    issuer?: string | null;
    clientId?: string | null;
    idToken: string;
    accessToken: string;
    refreshToken: string;
    openaiApiKey?: string | null;
  },
  codexHome?: string,
): Promise<ChatgptAuthJson> {
  const next = buildChatgptAuthJson(input);
  const authPath = getCodexAuthPath(codexHome);
  await atomicWriteFile(authPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
}

export async function writeChatgptAuthJson(
  input: {
    issuer?: string | null;
    clientId?: string | null;
    idToken: string;
    accessToken: string;
    refreshToken: string;
    openaiApiKey?: string | null;
  },
  codexHome?: string,
): Promise<ChatgptAuthJson> {
  return writeRuntimeChatgptAuthJson(input, codexHome);
}

export async function persistOpenAiAuth(
  input: {
    issuer?: string | null;
    clientId?: string | null;
    idToken: string;
    accessToken: string;
    refreshToken: string;
    openaiApiKey?: string | null;
  },
  codexHome?: string,
  switchHome?: string,
): Promise<ChatgptAuthJson> {
  const next = await writeSwitchChatgptAuthJson(input, switchHome);
  await writeRuntimeChatgptAuthJson(input, codexHome);
  return next;
}

export async function syncSwitchAuthToCodex(codexHome?: string, switchHome?: string): Promise<ChatgptAuthJson | null> {
  const auth = await readSwitchAuthJson(switchHome);
  if (!auth || typeof auth !== "object" || !("tokens" in auth)) {
    return null;
  }

  const chatgptAuth = auth as ChatgptAuthJson;
  const tokens = chatgptAuth.tokens;
  if (!tokens?.id_token || !tokens.access_token || !tokens.refresh_token) {
    return null;
  }

  return writeRuntimeChatgptAuthJson(
    {
      issuer: chatgptAuth.issuer ?? null,
      clientId: chatgptAuth.client_id ?? null,
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      openaiApiKey: chatgptAuth.openai_api_key ?? null,
    },
    codexHome,
  );
}
