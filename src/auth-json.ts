import {
  atomicWriteFile,
  getCodexAuthPath,
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
  openai_api_key?: string | null;
  tokens?: ChatgptTokenBundle | null;
  last_refresh?: string | null;
  agent_identity?: unknown;
}

export type AuthJson = LegacyApiKeyAuthJson | ChatgptAuthJson;

export async function readAuthJson(codexHome?: string): Promise<AuthJson | null> {
  const authPath = getCodexAuthPath(codexHome);
  const raw = await readFileIfExists(authPath);
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as AuthJson;
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

export async function writeChatgptAuthJson(
  input: {
    idToken: string;
    accessToken: string;
    refreshToken: string;
    openaiApiKey?: string | null;
  },
  codexHome?: string,
): Promise<ChatgptAuthJson> {
  const accountId = getChatgptAccountIdFromJwt(input.idToken) ||
    getChatgptAccountIdFromJwt(input.accessToken);

  const next: ChatgptAuthJson = {
    auth_mode: "chatgpt",
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

  const authPath = getCodexAuthPath(codexHome);
  await atomicWriteFile(authPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
}
