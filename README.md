# codex-ark-proxy

让本机 `codex` 直接通过 Ark / Doubao 跑 OpenAI Responses 的本地代理。

## 快速开始

安装：

```bash
curl -fsSL https://haoxingjun-test.tos-cn-beijing.volces.com/bootstrap-codex-ark.sh | ARK_API_KEY=你的方舟Key bash
```

如果目标机器连不上 GitHub，脚本会自动回退到公共桶里的代码包继续安装。

使用：

```bash
codex-arkproxy --model doubao-seed-2-0-pro-260215
```

`gpt-*` 模型会绕过本地代理，直接交给原生 Codex/OpenAI 配置，例如：

```bash
codex-arkproxy --model gpt-5.5
```

`doubao-*` 模型才会进入 `codex-ark-proxy`。

如果当前 shell 还找不到 `codex-arkproxy`：

```bash
exec "$SHELL" -l
```

## 验证

代理健康检查：

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/v1/models
```

## Ark 扩展配置

安装脚本支持把 region、endpoint 和额外 header 写入代理环境，便于对接非默认区域或 endpoint 型方舟资源：

```bash
curl -fsSL https://haoxingjun-test.tos-cn-beijing.volces.com/bootstrap-codex-ark.sh | \
  ARK_API_KEY=你的方舟Key \
  ARK_REGION=sg \
  ARK_ENDPOINT=ep-xxxxxxxx \
  bash
```

可选变量：

- `ARK_REGION`: 透传为 `X-User-Region`。
- `ARK_ENDPOINT`: 透传为 `X-User-Model`。
- `ARK_EXTRA_HEADERS_JSON`: 透传额外上游 header，`authorization` 和 `content-type` 会被代理保护性忽略。
- `EXPOSE_MODELS`: 控制代理 `/v1/models` 和安装生成的 `model_catalog_json`。默认只暴露 `doubao-*`，避免把 `gpt-*` 映射到豆包造成误解。

## Ark Responses API

`codex-ark-proxy` 只走 Ark Responses API，不走 `/chat/completions`。默认配置：

- `ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3`
- `ARK_API_MODE=responses`

如需关闭安装时的 Responses API 可用性探测：

```bash
AUTO_DETECT_ARK_API_MODE=false
```

最小 smoke：

```bash
codex-arkproxy exec -C /Users/bytedance/Code/arkclaw-hermes --model doubao-seed-2-0-pro-260215 "Reply with exactly: smoke-ok"
```

## 卸载

```bash
curl -fsSL https://haoxingjun-test.tos-cn-beijing.volces.com/uninstall-codex-ark.sh | bash
```

## 脚本会做什么

- 拉取或更新仓库到本地安装目录
- 安装依赖并构建代理
- 生成独立的 `~/.codex-arkproxy`
- 写入 `config.toml` 和 `.env`
- 修复 Doubao 模型缓存
- 安装 `codex-arkproxy` 启动命令
- 注册并启动后台代理服务

后台服务策略：

- macOS: `launchd`
- Linux: 优先 `systemd --user`
- Linux root: 优先系统级 `systemd`
- 兜底: `nohup`

## 要求

- Node.js 20+
- 可用的 Ark API Key

脚本默认会自动安装 `codex` CLI；如果你不想自动安装，可以在执行时加：

```bash
INSTALL_CODEX_CLI=false
```

## 开发

```bash
npm run check
npm test
```

核心文件：

- `src/`: 代理实现
- `scripts/repair-model-cache.mjs`: 模型缓存修复
- `bootstrap-codex-ark.sh`: 一键安装脚本

## 已知情况

- Codex 客户端偶尔会打印 `failed to record rollout items: thread ... not found`，这是客户端本地 rollout 持久化问题，不影响代理请求结果。
