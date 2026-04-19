import { atomicWriteFile, getProviderStorePath, readFileIfExists } from "./utils.js";

export interface ProviderRecord {
  name: string;
  baseUrl: string;
  sk: string;
  createdAt: string;
  updatedAt: string;
}

interface ProviderStoreData {
  providers: ProviderRecord[];
}

function normalizeStoreData(data: unknown): ProviderStoreData {
  if (!data || typeof data !== "object") {
    return { providers: [] };
  }

  const providers = Array.isArray((data as { providers?: unknown }).providers)
    ? (data as { providers: unknown[] }).providers
        .filter((item): item is ProviderRecord => {
          return !!item &&
            typeof item === "object" &&
            typeof (item as ProviderRecord).name === "string" &&
            typeof (item as ProviderRecord).baseUrl === "string" &&
            typeof (item as ProviderRecord).sk === "string" &&
            typeof (item as ProviderRecord).createdAt === "string" &&
            typeof (item as ProviderRecord).updatedAt === "string";
        })
    : [];

  return { providers };
}

export async function loadProviderStore(switchHome?: string): Promise<ProviderStoreData> {
  const filePath = getProviderStorePath(switchHome);
  const raw = await readFileIfExists(filePath);
  if (!raw) {
    return { providers: [] };
  }

  return normalizeStoreData(JSON.parse(raw));
}

export async function saveProviderStore(
  store: ProviderStoreData,
  switchHome?: string,
): Promise<void> {
  const filePath = getProviderStorePath(switchHome);
  const content = `${JSON.stringify(store, null, 2)}\n`;
  await atomicWriteFile(filePath, content, 0o600);
}

export async function listProviders(switchHome?: string): Promise<ProviderRecord[]> {
  const store = await loadProviderStore(switchHome);
  return [...store.providers].sort((left, right) => left.name.localeCompare(right.name));
}

export async function getProvider(
  name: string,
  switchHome?: string,
): Promise<ProviderRecord | null> {
  const store = await loadProviderStore(switchHome);
  return store.providers.find((item) => item.name === name) || null;
}

export async function upsertProvider(
  input: { name: string; baseUrl: string; sk: string },
  switchHome?: string,
): Promise<ProviderRecord> {
  const store = await loadProviderStore(switchHome);
  const now = new Date().toISOString();
  const existing = store.providers.find((item) => item.name === input.name);

  const next: ProviderRecord = existing
    ? {
        ...existing,
        baseUrl: input.baseUrl,
        sk: input.sk,
        updatedAt: now,
      }
    : {
        name: input.name,
        baseUrl: input.baseUrl,
        sk: input.sk,
        createdAt: now,
        updatedAt: now,
      };

  const providers = existing
    ? store.providers.map((item) => (item.name === next.name ? next : item))
    : [...store.providers, next];

  await saveProviderStore({ providers }, switchHome);
  return next;
}

export async function removeProvider(name: string, switchHome?: string): Promise<boolean> {
  const store = await loadProviderStore(switchHome);
  const providers = store.providers.filter((item) => item.name !== name);
  if (providers.length === store.providers.length) {
    return false;
  }
  await saveProviderStore({ providers }, switchHome);
  return true;
}
