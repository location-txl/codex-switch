#!/usr/bin/env node

import { getCurrentProviderInfo, removeManagedProviderConfig, setCurrentProviderToOpenAI, upsertManagedProviderConfig } from "./codex-config.js";
import { DEFAULT_OPENAI_CLIENT_ID, DEFAULT_OPENAI_ISSUER, RESERVED_PROVIDER_IDS } from "./constants.js";
import { getLegacyApiKey, readAuthJson, readSwitchAuthJson } from "./auth-json.js";
import { refreshStoredOpenAiAuth, runOpenAiBrowserLogin, runOpenAiDeviceLogin } from "./openai-oauth.js";
import { getProvider, listProviders, removeProvider, upsertProvider } from "./provider-store.js";
import { runTokenCommand } from "./token-command.js";
import { getCodexHome, getSwitchHome, isProviderIdValid, maskSecret } from "./utils.js";
import { clearConfiguredCodexHome, readConfiguredCodexHomeSync, writeConfiguredCodexHome } from "./app-config.js";

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["--debug", "--browser", "--device"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }

    const [flag, inlineValue] = item.split("=", 2);
    if (inlineValue !== undefined) {
      flags.set(flag, inlineValue);
      continue;
    }

    if (BOOLEAN_FLAGS.has(flag)) {
      flags.set(flag, true);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(flag, next);
      index += 1;
      continue;
    }

    flags.set(flag, true);
  }

  return { positionals, flags };
}

function getStringFlag(flags: Map<string, string | boolean>, name: string): string | null {
  const value = flags.get(name);
  return typeof value === "string" ? value : null;
}

function hasFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true || typeof flags.get(name) === "string";
}

function printHelp(): void {
  process.stdout.write(
    [
      "codex-switch",
      "",
      "命令：",
      "  codex-switch current",
      "  codex-switch list",
      "  codex-switch add <name> --base-url <url> --sk <key>",
      "  codex-switch use <name>",
      "  codex-switch use openai",
      "  codex-switch remove <name>",
      "  codex-switch login openai [--browser|--device]",
      "  codex-switch home set <path>",
      "  codex-switch home show",
      "  codex-switch home clear",
      "  codex-switch token <name>",
      "",
      "全局选项：",
      "  --codex-home <path>    仅当前命令覆盖 Codex 配置目录",
      "  --debug                输出脱敏后的详细调试日志",
      "",
    ].join("\n"),
  );
}

function assertProviderName(name: string): void {
  if (!isProviderIdValid(name)) {
    throw new Error("provider 名称不合法，只允许字母、数字、点、下划线、横线");
  }
  if (RESERVED_PROVIDER_IDS.has(name)) {
    throw new Error(`provider 名称 ${name} 是 Codex 保留值`);
  }
}

async function handleCurrent(codexHome?: string): Promise<void> {
  const current = await getCurrentProviderInfo(codexHome);
  const runtimeAuth = await readAuthJson(codexHome);
  const switchAuth = await readSwitchAuthJson();
  const legacyApiKey = getLegacyApiKey(runtimeAuth);
  const switchTokens =
    switchAuth &&
      "tokens" in switchAuth &&
      switchAuth.tokens?.id_token &&
      switchAuth.tokens.access_token &&
      switchAuth.tokens.refresh_token
      ? switchAuth.tokens
      : null;
  const switchApiKey =
    switchAuth && "openai_api_key" in switchAuth && typeof switchAuth.openai_api_key === "string"
      ? switchAuth.openai_api_key
      : null;
  const switchLastRefresh =
    switchAuth && "last_refresh" in switchAuth && typeof switchAuth.last_refresh === "string"
      ? switchAuth.last_refresh
      : "-";

  process.stdout.write(
    [
      `provider: ${current.providerId ?? "-"}`,
      `base_url: ${current.baseUrl ?? "-"}`,
      `auth_mode: ${current.authMode ?? "-"}`,
      `managed: ${current.managedByCodexSwitch ? "yes" : "no"}`,
      `codex_home: ${codexHome || getCodexHome()}`,
      `switch_store: ${getSwitchHome()}`,
      `openai_login: ${switchTokens ? "yes" : "no"}`,
      `openai_last_refresh: ${switchLastRefresh}`,
      `openai_api_key: ${switchApiKey ? maskSecret(switchApiKey) : "-"}`,
      `legacy_openai_api_key: ${legacyApiKey ? maskSecret(legacyApiKey) : "-"}`,
    ].join("\n") + "\n",
  );
}

async function handleList(): Promise<void> {
  const providers = await listProviders();
  if (providers.length === 0) {
    process.stdout.write("没有已保存的第三方 provider\n");
    return;
  }

  for (const provider of providers) {
    process.stdout.write(`${provider.name}\t${provider.baseUrl}\t${maskSecret(provider.sk)}\n`);
  }
}

async function handleAdd(parsed: ParsedArgs, codexHome?: string): Promise<void> {
  const name = parsed.positionals[1];
  if (!name) {
    throw new Error("缺少 provider 名称");
  }

  assertProviderName(name);
  const baseUrl = getStringFlag(parsed.flags, "--base-url");
  const sk = getStringFlag(parsed.flags, "--sk");
  if (!baseUrl) {
    throw new Error("缺少 --base-url");
  }
  if (!sk) {
    throw new Error("缺少 --sk");
  }

  const provider = await upsertProvider({ name, baseUrl, sk });
  await upsertManagedProviderConfig({ name, baseUrl, setActive: false }, codexHome);
  process.stdout.write(`已保存 provider ${provider.name}\n`);
}

async function handleUse(parsed: ParsedArgs, codexHome?: string): Promise<void> {
  const name = parsed.positionals[1];
  if (!name) {
    throw new Error("缺少 provider 名称");
  }

  if (name === "openai") {
    const switchAuth = await readSwitchAuthJson();
    if (switchAuth) {
      await refreshStoredOpenAiAuth({ codexHome });
    }
    await setCurrentProviderToOpenAI(codexHome);
    process.stdout.write("已切换到 OpenAI 官方 provider\n");
    return;
  }

  const provider = await getProvider(name);
  if (!provider) {
    throw new Error(`provider ${name} 不存在`);
  }

  await upsertManagedProviderConfig({
    name: provider.name,
    baseUrl: provider.baseUrl,
    setActive: true,
  }, codexHome);
  process.stdout.write(`已切换到 provider ${provider.name}\n`);
}

async function handleRemove(parsed: ParsedArgs, codexHome?: string): Promise<void> {
  const name = parsed.positionals[1];
  if (!name) {
    throw new Error("缺少 provider 名称");
  }
  if (name === "openai") {
    throw new Error("不能删除 openai provider");
  }

  const current = await getCurrentProviderInfo(codexHome);
  if (current.providerId === name) {
    throw new Error("当前正在使用该 provider，请先切换到其他 provider 再删除");
  }

  const removed = await removeProvider(name);
  await removeManagedProviderConfig(name, codexHome);
  if (!removed) {
    throw new Error(`provider ${name} 不存在`);
  }
  process.stdout.write(`已删除 provider ${name}\n`);
}

async function handleLogin(parsed: ParsedArgs, codexHome?: string): Promise<void> {
  const target = parsed.positionals[1];
  if (target !== "openai") {
    throw new Error("当前只支持 login openai");
  }

  const issuer = getStringFlag(parsed.flags, "--experimental-issuer") || DEFAULT_OPENAI_ISSUER;
  const clientId =
    getStringFlag(parsed.flags, "--experimental-client-id") || DEFAULT_OPENAI_CLIENT_ID;
  const device = hasFlag(parsed.flags, "--device");
  const browser = hasFlag(parsed.flags, "--browser");
  const debug = hasFlag(parsed.flags, "--debug");

  if (device && browser) {
    throw new Error("--browser 与 --device 不能同时使用");
  }

  const result = device
    ? await runOpenAiDeviceLogin({ issuer, clientId, codexHome, debug })
    : await runOpenAiBrowserLogin({ issuer, clientId, codexHome, debug });
  await setCurrentProviderToOpenAI(codexHome);

  process.stdout.write(
    [
      "OpenAI 登录成功",
      `auth_mode: chatgpt`,
      `openai_api_key: ${result.openaiApiKey ? maskSecret(result.openaiApiKey) : "-"}`,
    ].join("\n") + "\n",
  );
}

async function handleHome(parsed: ParsedArgs): Promise<void> {
  const subcommand = parsed.positionals[1];

  switch (subcommand) {
    case "set": {
      const targetPath = parsed.positionals[2];
      if (!targetPath) {
        throw new Error("缺少目录路径");
      }
      await writeConfiguredCodexHome(targetPath);
      process.stdout.write(`已设置默认 Codex 目录：${targetPath}\n`);
      return;
    }
    case "show": {
      const configured = readConfiguredCodexHomeSync();
      const resolved = getCodexHome();
      process.stdout.write(
        [
          `configured: ${configured ?? "-"}`,
          `resolved: ${resolved}`,
        ].join("\n") + "\n",
      );
      return;
    }
    case "clear": {
      await clearConfiguredCodexHome();
      process.stdout.write("已清除默认 Codex 目录配置\n");
      return;
    }
    default:
      throw new Error("home 只支持 set/show/clear");
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  const command = parsed.positionals[0];
  const codexHome = getStringFlag(parsed.flags, "--codex-home") || undefined;

  if (codexHome) {
    process.env.CODEX_HOME = codexHome;
  }

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "token") {
    const name = parsed.positionals[1];
    if (!name) {
      throw new Error("缺少 provider 名称");
    }
    await runTokenCommand(name);
    return;
  }

  switch (command) {
    case "current":
      await handleCurrent(codexHome);
      return;
    case "list":
      await handleList();
      return;
    case "add":
      await handleAdd(parsed, codexHome);
      return;
    case "use":
      await handleUse(parsed, codexHome);
      return;
    case "remove":
      await handleRemove(parsed, codexHome);
      return;
    case "login":
      await handleLogin(parsed, codexHome);
      return;
    case "home":
      await handleHome(parsed);
      return;
    default:
      throw new Error(`未知命令：${command}`);
  }
}

const isMainModule = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  main().catch((error) => {
    process.stderr.write(`错误：${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
