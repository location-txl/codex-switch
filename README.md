# codex-switch

一个本地 TypeScript CLI，用于切换 Codex 的模型提供商：

- 切回 OpenAI 官方服务
- 配置并切换多个第三方 provider
- 直接执行 OpenAI ChatGPT OAuth（浏览器 / device code）
- 只增量修改 `~/.codex/config.toml` 与 `~/.codex/auth.json`

## 开发

```bash
npm install
npm run build
npm test
```

## 命令

```bash
codex-switch current
codex-switch list
codex-switch add <name> --base-url <url> --sk <key>
codex-switch use <name>
codex-switch use openai
codex-switch remove <name>
codex-switch login openai --browser
codex-switch login openai --device
```
