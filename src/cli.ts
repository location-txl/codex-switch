#!/usr/bin/env node

import yargs from "yargs/yargs";
import type { ArgumentsCamelCase, Argv } from "yargs";
import { hideBin } from "yargs/helpers";

import { getCurrentProviderInfo, removeManagedProviderConfig, setCurrentProviderToOpenAI, upsertManagedProviderConfig } from "./codex-config.js";
import { DEFAULT_OPENAI_CLIENT_ID, DEFAULT_OPENAI_ISSUER, RESERVED_PROVIDER_IDS } from "./constants.js";
import { getLegacyApiKey, readAuthJson, readSwitchAuthJson, writeRuntimeLegacyApiKeyAuthJson } from "./auth-json.js";
import { refreshStoredOpenAiAuth, runOpenAiBrowserLogin, runOpenAiDeviceLogin } from "./openai-oauth.js";
import { getProvider, listProviders, removeProvider, upsertProvider } from "./provider-store.js";
import { runTokenCommand } from "./token-command.js";
import { getCodexHome, getSwitchHome, isProviderIdValid, maskSecret } from "./utils.js";
import { clearConfiguredCodexHome, readConfiguredCodexHomeSync, writeConfiguredCodexHome } from "./app-config.js";

interface GlobalOptions {
  "codex-home"?: string;
  debug?: boolean;
}

type CliArgs<T> = ArgumentsCamelCase<T & GlobalOptions>;

function applyCodexHome(argv: GlobalOptions): string | undefined {
  const codexHome = argv["codex-home"];
  if (codexHome) {
    process.env.CODEX_HOME = codexHome;
  }
  return codexHome;
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

async function handleAdd(name: string, baseUrl: string, sk: string, codexHome?: string): Promise<void> {
  assertProviderName(name);
  const provider = await upsertProvider({ name, baseUrl, sk });
  await upsertManagedProviderConfig({ name, baseUrl, setActive: false }, codexHome);
  process.stdout.write(`已保存 provider ${provider.name}\n`);
}

async function handleUse(name: string, codexHome?: string): Promise<void> {
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
  await writeRuntimeLegacyApiKeyAuthJson(provider.sk, codexHome);
  process.stdout.write(`已切换到 provider ${provider.name}\n`);
}

async function handleRemove(name: string, codexHome?: string): Promise<void> {
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

async function handleLogin(input: {
  target: string;
  issuer?: string;
  clientId?: string;
  device?: boolean;
  browser?: boolean;
  debug?: boolean;
  codexHome?: string;
}): Promise<void> {
  const { target, codexHome } = input;
  if (target !== "openai") {
    throw new Error("当前只支持 login openai");
  }

  const issuer = input.issuer || DEFAULT_OPENAI_ISSUER;
  const clientId = input.clientId || DEFAULT_OPENAI_CLIENT_ID;
  const device = input.device === true;
  const browser = input.browser === true;
  const debug = input.debug === true;

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

async function handleHomeSet(targetPath: string): Promise<void> {
  await writeConfiguredCodexHome(targetPath);
  process.stdout.write(`已设置默认 Codex 目录：${targetPath}\n`);
}

function handleHomeShow(): void {
  const configured = readConfiguredCodexHomeSync();
  const resolved = getCodexHome();
  process.stdout.write(
    [
      `configured: ${configured ?? "-"}`,
      `resolved: ${resolved}`,
    ].join("\n") + "\n",
  );
}

async function handleHomeClear(): Promise<void> {
  await clearConfiguredCodexHome();
  process.stdout.write("已清除默认 Codex 目录配置\n");
}

function createCli(argv: string[]): Argv<GlobalOptions> {
  const cli = yargs(argv)
    .scriptName("codex-switch")
    .usage("$0 <command> [options]")
    .parserConfiguration({
      "boolean-negation": false,
      "camel-case-expansion": false,
      "parse-numbers": false,
      "parse-positional-numbers": false,
      "populate--": false,
    })
    .option("codex-home", {
      type: "string",
      global: true,
      describe: "仅当前命令覆盖 Codex 配置目录",
    })
    .option("debug", {
      type: "boolean",
      global: true,
      describe: "输出脱敏后的详细调试日志",
    })
    .command(
      "$0",
      false,
      (builder) => builder,
      () => {
        cli.showHelp((help) => {
          process.stdout.write(`${help}\n`);
        });
      },
    )
    .command(
      "current",
      "显示当前 provider",
      (builder) => builder,
      async (argv) => {
        const args = argv as CliArgs<GlobalOptions>;
        await handleCurrent(applyCodexHome(args));
      },
    )
    .command(
      "list",
      "列出已保存的第三方 provider",
      (builder) => builder,
      async () => {
        await handleList();
      },
    )
    .command(
      "add <name>",
      "保存第三方 provider",
      (builder) =>
        builder
          .positional("name", {
            type: "string",
            demandOption: true,
            describe: "provider 名称",
          })
          .option("base-url", {
            type: "string",
            demandOption: true,
            describe: "OpenAI 兼容 API base URL",
          })
          .option("sk", {
            type: "string",
            demandOption: true,
            describe: "provider API key",
          }),
      async (argv) => {
        const args = argv as CliArgs<{ name: string; "base-url": string; sk: string }>;
        await handleAdd(args.name, args["base-url"], args.sk, applyCodexHome(args));
      },
    )
    .command(
      "use <name>",
      "切换当前 provider",
      (builder) =>
        builder.positional("name", {
          type: "string",
          demandOption: true,
          describe: "provider 名称，或 openai",
        }),
      async (argv) => {
        const args = argv as CliArgs<{ name: string }>;
        await handleUse(args.name, applyCodexHome(args));
      },
    )
    .command(
      "remove <name>",
      "删除第三方 provider",
      (builder) =>
        builder.positional("name", {
          type: "string",
          demandOption: true,
          describe: "provider 名称",
        }),
      async (argv) => {
        const args = argv as CliArgs<{ name: string }>;
        await handleRemove(args.name, applyCodexHome(args));
      },
    )
    .command(
      "login <target>",
      "登录 provider",
      (builder) =>
        builder
          .positional("target", {
            type: "string",
            demandOption: true,
            describe: "当前只支持 openai",
          })
          .option("browser", {
            type: "boolean",
            describe: "使用浏览器登录",
          })
          .option("device", {
            type: "boolean",
            describe: "使用设备码登录",
          })
          .option("experimental-issuer", {
            type: "string",
            describe: "实验性 OAuth issuer",
          })
          .option("experimental-client-id", {
            type: "string",
            describe: "实验性 OAuth client id",
          }),
      async (argv) => {
        const args = argv as CliArgs<{
          target: string;
          browser?: boolean;
          device?: boolean;
          "experimental-issuer"?: string;
          "experimental-client-id"?: string;
        }>;
        await handleLogin({
          target: args.target,
          issuer: args["experimental-issuer"],
          clientId: args["experimental-client-id"],
          browser: args.browser,
          device: args.device,
          debug: args.debug,
          codexHome: applyCodexHome(args),
        });
      },
    )
    .command(
      "home set <path>",
      "设置默认 Codex 配置目录",
      (builder) =>
        builder.positional("path", {
          type: "string",
          demandOption: true,
          describe: "默认 Codex 配置目录",
        }),
      async (argv) => {
        const args = argv as ArgumentsCamelCase<{ path: string }>;
        await handleHomeSet(args.path);
      },
    )
    .command(
      "home show",
      "显示默认 Codex 配置目录",
      (builder) => builder,
      () => {
        handleHomeShow();
      },
    )
    .command(
      "home clear",
      "清除默认 Codex 配置目录",
      (builder) => builder,
      async () => {
        await handleHomeClear();
      },
    )
    .command(
      "token <name>",
      "输出 provider API key",
      (builder) =>
        builder.positional("name", {
          type: "string",
          demandOption: true,
          describe: "provider 名称",
        }),
      async (argv) => {
        const args = argv as ArgumentsCamelCase<{ name: string }>;
        await runTokenCommand(args.name);
      },
    )
    .strict()
    .recommendCommands()
    .help()
    .alias("h", "help")
    .wrap(100)
    .exitProcess(false)
    .fail((message, error) => {
      throw error || new Error(message);
    });

  return cli;
}

export async function main(argv: string[] = hideBin(process.argv)): Promise<void> {
  await createCli(argv).parseAsync();
}

const isMainModule = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  main().catch((error) => {
    process.stderr.write(`错误：${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
