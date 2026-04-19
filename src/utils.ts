import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AUTH_BASENAME,
  CONFIG_BASENAME,
  DEFAULT_CODEX_HOME_DIRNAME,
  PROVIDER_STORE_BASENAME,
  SWITCH_HOME_DIRNAME,
} from "./constants.js";
import { readConfiguredCodexHomeSync } from "./app-config.js";

export function getCodexHome(): string {
  return process.env.CODEX_HOME ||
    readConfiguredCodexHomeSync() ||
    path.join(os.homedir(), DEFAULT_CODEX_HOME_DIRNAME);
}

export function getSwitchHome(): string {
  return process.env.CODEX_SWITCH_HOME || path.join(os.homedir(), SWITCH_HOME_DIRNAME);
}

export function getCodexConfigPath(codexHome = getCodexHome()): string {
  return path.join(codexHome, CONFIG_BASENAME);
}

export function getCodexAuthPath(codexHome = getCodexHome()): string {
  return path.join(codexHome, AUTH_BASENAME);
}

export function getSwitchAuthPath(switchHome = getSwitchHome()): string {
  return path.join(switchHome, AUTH_BASENAME);
}

export function getProviderStorePath(switchHome = getSwitchHome()): string {
  return path.join(switchHome, PROVIDER_STORE_BASENAME);
}

export async function ensureDir(dirPath: string, mode = 0o700): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode });
  if (process.platform !== "win32") {
    await fs.chmod(dirPath, mode);
  }
}

export async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  await ensureDir(path.dirname(filePath), 0o700);
  const tempName = `${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const tempPath = path.join(path.dirname(filePath), tempName);
  await fs.writeFile(tempPath, content, { encoding: "utf8", mode });
  if (process.platform !== "win32") {
    await fs.chmod(tempPath, mode);
  }
  await fs.rename(tempPath, filePath);
  if (process.platform !== "win32") {
    await fs.chmod(filePath, mode);
  }
}

export function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function quoteTomlString(value: string): string {
  return `"${escapeTomlString(value)}"`;
}

export function isProviderIdValid(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return "*".repeat(secret.length);
  }
  return `${secret.slice(0, 4)}***${secret.slice(-4)}`;
}

export function parseJwtClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return {};
  }

  try {
    const payload = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getNestedRecord(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = input[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
