import { MANAGED_BLOCK_END, MANAGED_BLOCK_START } from "./constants.js";
import {
  atomicWriteFile,
  escapeTomlString,
  getCodexConfigPath,
  quoteTomlString,
  readFileIfExists,
} from "./utils.js";

export interface CurrentProviderInfo {
  providerId: string | null;
  baseUrl: string | null;
  authMode: string | null;
  managedByCodexSwitch: boolean;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findFirstTableIndex(text: string): number {
  const match = text.match(/^\[[^\n]+\]\s*$/m);
  return match?.index ?? text.length;
}

function setTopLevelString(text: string, key: string, value: string): string {
  const replacement = `${key} = ${quoteTomlString(value)}`;
  const pattern = new RegExp(`^${escapeRegex(key)}\\s*=.*$`, "m");
  if (pattern.test(text)) {
    return text.replace(pattern, replacement);
  }

  const insertAt = findFirstTableIndex(text);
  const prefix = text.slice(0, insertAt);
  const suffix = text.slice(insertAt);
  const joiner = prefix.length > 0 && !prefix.endsWith("\n") ? "\n" : "";
  return `${prefix}${joiner}${replacement}\n${suffix}`;
}

function managedBlockRegex(name: string): RegExp {
  return new RegExp(
    `${escapeRegex(MANAGED_BLOCK_START + name)}[\\s\\S]*?${escapeRegex(MANAGED_BLOCK_END + name)}\\n?`,
    "g",
  );
}

function removeManagedProviderBlock(text: string, name: string): string {
  return text.replace(managedBlockRegex(name), "");
}

function hasManagedProviderBlock(text: string, name: string): boolean {
  return managedBlockRegex(name).test(text);
}

function hasUserProviderBlock(text: string, name: string): boolean {
  const stripped = text.replace(managedBlockRegex(name), "");
  const sectionPattern = new RegExp(
    `^\\[model_providers\\.${escapeRegex(name)}(?:\\]|\\.)`,
    "m",
  );
  return sectionPattern.test(stripped);
}

function buildManagedProviderBlock(name: string, baseUrl: string): string {
  return [
    `${MANAGED_BLOCK_START}${name}`,
    `[model_providers.${name}]`,
    `name = ${quoteTomlString(name)}`,
    `base_url = ${quoteTomlString(baseUrl)}`,
    `wire_api = "responses"`,
    ``,
    `[model_providers.${name}.auth]`,
    `command = "codex-switch"`,
    `args = ["token", ${quoteTomlString(name)}]`,
    `${MANAGED_BLOCK_END}${name}`,
    ``,
  ].join("\n");
}

function appendManagedProviderBlock(text: string, block: string): string {
  const trimmed = text.replace(/\s*$/, "");
  return `${trimmed}\n\n${block}`;
}

function findTopLevelStringValue(text: string, key: string): string | null {
  const pattern = new RegExp(`^${escapeRegex(key)}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`, "m");
  const match = text.match(pattern);
  if (!match) {
    return null;
  }
  return match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function parseProviderSection(
  text: string,
  providerId: string,
): { baseUrl: string | null; authMode: string | null } {
  const sectionPrefix = `model_providers.${providerId}`;
  const lines = text.split("\n");
  const collected: string[] = [];
  let inTargetSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const sectionName = sectionMatch[1]!;
      inTargetSection =
        sectionName === sectionPrefix || sectionName.startsWith(`${sectionPrefix}.`);
    }

    if (inTargetSection) {
      collected.push(line);
    }
  }

  if (collected.length === 0) {
    return { baseUrl: null, authMode: null };
  }

  const block = collected.join("\n");
  const baseUrl = findTopLevelStringValue(block, "base_url");
  const hasAuthCommand = /^\[model_providers\.[^.]+\.(auth)\]\s*$/m.test(block) || /command\s*=/.test(block);
  const requiresOpenaiAuth = /^requires_openai_auth\s*=\s*true$/m.test(block);
  const envKey = /^env_key\s*=\s*"[^"]+"/m.test(block);
  const authMode = hasAuthCommand
    ? "auth.command"
    : requiresOpenaiAuth
      ? "openai_auth"
      : envKey
        ? "env_key"
        : "none";

  return { baseUrl, authMode };
}

export async function readCodexConfigText(codexHome?: string): Promise<string> {
  const configPath = getCodexConfigPath(codexHome);
  return (await readFileIfExists(configPath)) ?? "";
}

export async function writeCodexConfigText(text: string, codexHome?: string): Promise<void> {
  const configPath = getCodexConfigPath(codexHome);
  await atomicWriteFile(configPath, text.replace(/\s*$/, "\n"), 0o600);
}

export async function setCurrentProviderToOpenAI(codexHome?: string): Promise<void> {
  let text = await readCodexConfigText(codexHome);
  text = setTopLevelString(text, "model_provider", "openai");
  text = setTopLevelString(text, "cli_auth_credentials_store", "file");
  await writeCodexConfigText(text, codexHome);
}

export async function upsertManagedProviderConfig(
  input: { name: string; baseUrl: string; setActive?: boolean },
  codexHome?: string,
): Promise<void> {
  let text = await readCodexConfigText(codexHome);

  if (!hasManagedProviderBlock(text, input.name) && hasUserProviderBlock(text, input.name)) {
    throw new Error(`provider ${input.name} 已存在于 config.toml，且不是 codex-switch 托管的配置`);
  }

  text = removeManagedProviderBlock(text, input.name);
  text = appendManagedProviderBlock(text, buildManagedProviderBlock(input.name, input.baseUrl));
  if (input.setActive !== false) {
    text = setTopLevelString(text, "model_provider", input.name);
  }

  await writeCodexConfigText(text, codexHome);
}

export async function removeManagedProviderConfig(name: string, codexHome?: string): Promise<boolean> {
  let text = await readCodexConfigText(codexHome);
  const next = removeManagedProviderBlock(text, name);
  if (next === text) {
    return false;
  }
  text = next;
  await writeCodexConfigText(text, codexHome);
  return true;
}

export async function getCurrentProviderInfo(codexHome?: string): Promise<CurrentProviderInfo> {
  const text = await readCodexConfigText(codexHome);
  const providerId = findTopLevelStringValue(text, "model_provider");
  if (!providerId) {
    return {
      providerId: null,
      baseUrl: null,
      authMode: null,
      managedByCodexSwitch: false,
    };
  }

  if (providerId === "openai") {
    return {
      providerId,
      baseUrl: findTopLevelStringValue(text, "openai_base_url") || "https://api.openai.com/v1",
      authMode: "auth.json",
      managedByCodexSwitch: false,
    };
  }

  const parsed = parseProviderSection(text, providerId);
  return {
    providerId,
    baseUrl: parsed.baseUrl,
    authMode: parsed.authMode,
    managedByCodexSwitch: hasManagedProviderBlock(text, providerId),
  };
}
