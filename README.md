# codex-switch

一个本地 TypeScript CLI，用于切换 Codex 的模型提供商：

- 切回 OpenAI 官方服务
- 配置并切换多个第三方 provider
- 直接执行 OpenAI ChatGPT OAuth（浏览器 / device code）
- 将 codex-switch 自己管理的 OpenAI 登录态与第三方 provider 配置存到 `~/.codex-switch`
- 按需增量修改 Codex 运行时的 `~/.codex/config.toml` 与 `~/.codex/auth.json`

## 存储位置

`~/.codex-switch` 是 codex-switch 的私有状态目录：

- `auth.json`：保存 OpenAI/OpenID 登录后的 token、refresh token、issuer、client id 与换取到的 OpenAI API key
- `codex-switch.providers.json`：保存第三方 provider 的名称、base URL 与密钥

Codex 自己运行时仍然读取 `~/.codex`（或 `--codex-home` 指定目录）：

- `config.toml`：记录当前启用的 provider 与 provider 接线方式
- `auth.json`：保存同步给 Codex 使用的 OpenAI 登录态副本

注意：新版本不会自动迁移旧的 `~/.codex/auth.json` 或旧 provider store。首次使用新版本时，请按需执行 `codex-switch login openai` 和需要的 `codex-switch add ...`。

第三方 provider 使用各自保存的 API key；切换第三方 provider 时，CLI 会把对应密钥写入 Codex 运行时 `auth.json` 的 `OPENAI_API_KEY`。切换第三方 provider 不需要 OpenAI 登录态。切回 OpenAI 官方 provider 时，CLI 会优先刷新 `~/.codex-switch/auth.json` 中保存的 OpenAI 登录态，并同步到 Codex 运行时 `auth.json`。

## 开发

```bash
npm install
npm run build
npm run build:watch
npm test
```

## 本地调试

这个项目是一个 Node.js CLI，入口在 `src/cli.ts`，构建产物默认在 `dist/src/cli.js`。

日常调试建议开两个终端：

```bash
# 终端 1：持续编译
npm run build:watch

# 终端 2：执行命令
node dist/src/cli.js current --codex-home /tmp/codex-switch-debug
```

如果要断点调试，可以直接让 Node 开 inspector：

```bash
node --inspect-brk dist/src/cli.js current --codex-home /tmp/codex-switch-debug
```

然后用 Chrome DevTools 或 VS Code attach 到该进程。

这个 CLI 会读写 Codex 配置。调试时建议总是带上 `--codex-home /tmp/...`，避免误改真实的 `~/.codex`。

如需隔离 codex-switch 私有状态，测试时也可以设置 `CODEX_SWITCH_HOME=/tmp/...`。

## 本地执行

不安装到全局 NPM 包时，最稳妥的方式是直接执行编译产物：

```bash
npm run build
node dist/src/cli.js help
node dist/src/cli.js list --codex-home /tmp/codex-switch-debug
node dist/src/cli.js add demo --base-url https://example.com/v1 --sk sk-xxx --codex-home /tmp/codex-switch-debug
```

修正 `bin` 配置后，也可以像包一样在仓库内直接执行：

```bash
npm exec -- codex-switch help
npx --no-install codex-switch help
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
