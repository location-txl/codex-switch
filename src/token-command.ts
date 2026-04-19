import { getProvider } from "./provider-store.js";

export async function runTokenCommand(name: string): Promise<void> {
  const provider = await getProvider(name);
  if (!provider) {
    throw new Error(`provider ${name} 不存在`);
  }

  process.stdout.write(provider.sk);
}
