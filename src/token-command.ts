import { getProvider } from "./provider-store.js";

export async function runTokenCommand(name: string, codexHome?: string): Promise<void> {
  const provider = await getProvider(name, codexHome);
  if (!provider) {
    throw new Error(`provider ${name} 不存在`);
  }

  process.stdout.write(provider.sk);
}
