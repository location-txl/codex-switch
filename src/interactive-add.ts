import * as p from '@clack/prompts';
import { intro, outro, cancel, isCancel, log } from '@clack/prompts';
import { getProvider } from './provider-store.js';
import { isProviderIdValid, maskSecret } from './utils.js';
import { RESERVED_PROVIDER_IDS } from './constants.js';

export interface ProviderParams {
  name: string;
  baseUrl: string;
  sk: string;
}

/**
 * 校验 name（同步部分）
 */
function validateNameSync(v: string | undefined): string | undefined {
  if (!v) return '名称不能为空';
  if (!isProviderIdValid(v)) return '名称只允许字母、数字、点、下划线、横线';
  if (RESERVED_PROVIDER_IDS.has(v)) return `${v} 是 Codex 保留值`;
  return undefined;
}

/**
 * 提示并校验 name（含异步重名检查）
 */
async function promptName(): Promise<string> {
  while (true) {
    const input = await p.text({
      message: '请输入 provider 名称',
      validate: validateNameSync,
    });

    if (isCancel(input)) {
      cancel('操作已取消');
      process.exit(0);
    }

    // 异步校验重名
    const existing = await getProvider(input);
    if (existing) {
      log.error(`provider ${input} 已存在`);
      continue;
    }

    return input;
  }
}

export async function promptProviderParams(
  provided: Partial<ProviderParams>
): Promise<ProviderParams | null> {
  intro('添加 provider');

  // 如果 CLI 提供了 name，需检查重名
  if (provided.name) {
    const existing = await getProvider(provided.name);
    if (existing) {
      log.error(`provider ${provided.name} 已存在`);
      cancel('操作已取消');
      process.exit(0);
      return null;
    }
  }

  // 显示表单摘要
  log.info('需要填写以下信息：');
  log.step(`• 名称 ${provided.name ? `(已填: ${provided.name})` : '(待填)'}`);
  log.step(`• base URL ${provided.baseUrl ? `(已填: ${provided.baseUrl})` : '(待填)'}`);
  log.step(`• API key ${provided.sk ? '(已填)' : '(待填)'}`);

  // name 需要单独处理异步校验
  let name = provided.name;
  if (!name) {
    name = await promptName();
  }

  // 交互式收集 baseUrl 和 sk
  const result = await p.group({
    baseUrl: () => provided.baseUrl ? undefined : p.text({
      message: '请输入 base URL',
      validate: (v) => {
        if (!v) return 'base URL 不能为空';
        if (!v.startsWith('http://') && !v.startsWith('https://')) return 'URL 需以 http:// 或 https:// 开头';
      },
    }),
    sk: () => provided.sk ? undefined : p.text({
      message: '请输入 API key',
      validate: (v) => {
        if (!v) return 'API key 不能为空';
      },
    }),
  }, {
    onCancel: () => {
      cancel('操作已取消');
      process.exit(0);
    },
  });

  // 合并已提供和交互收集的参数
  const finalParams: ProviderParams = {
    name,
    baseUrl: provided.baseUrl ?? result.baseUrl!,
    sk: provided.sk ?? result.sk!,
  };

  // 确认摘要（默认确认）
  log.info('即将保存：');
  log.step(`name=${finalParams.name}`);
  log.step(`base-url=${finalParams.baseUrl}`);
  log.step(`sk=${maskSecret(finalParams.sk)}`);

  const confirmed = await p.confirm({
    message: '确认保存？',
    initialValue: true,
  });

  if (isCancel(confirmed) || !confirmed) {
    cancel('操作已取消');
    process.exit(0);
    return null;
  }

  return finalParams;
}