import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { APP_CONFIG_BASENAME } from "./constants.js";

interface AppConfigShape {
  codexHome?: string;
}

export function getAppConfigPath(): string {
  return path.join(os.homedir(), APP_CONFIG_BASENAME);
}

export function readAppConfigSync(): AppConfigShape {
  try {
    const raw = fs.readFileSync(getAppConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as AppConfigShape;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    return {};
  }
}

export function readConfiguredCodexHomeSync(): string | null {
  const config = readAppConfigSync();
  return typeof config.codexHome === "string" && config.codexHome.length > 0
    ? config.codexHome
    : null;
}

export async function writeConfiguredCodexHome(codexHome: string): Promise<void> {
  const filePath = getAppConfigPath();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify({ codexHome }, null, 2)}\n`;
  await fsPromises.writeFile(tempPath, content, { mode: 0o600, encoding: "utf8" });
  if (process.platform !== "win32") {
    await fsPromises.chmod(tempPath, 0o600);
  }
  await fsPromises.rename(tempPath, filePath);
}

export async function clearConfiguredCodexHome(): Promise<void> {
  try {
    await fsPromises.unlink(getAppConfigPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
