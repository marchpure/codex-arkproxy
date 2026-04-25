# codex-ark-proxy

一个本地代理，把 Codex 的 OpenAI Responses 请求转发到方舟 OpenAI-compatible 接口，让本机 Codex 可以直接跑在 Ark / Doubao 模型上。

当前已支持：

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /responses`
- 模型映射
- `web_search` 工具透传
- Responses SSE 回放
- `reasoning` / `function_call` / `message` 事件兼容
- 回放型 `input.status` 兼容

## 目录说明

- `src/`: 代理实现
- `scripts/repair-model-cache.mjs`: 修复 Codex 本地 `doubao` 模型元数据
- `test/`: 单测和路由集成测试

## 一键在 Codex 上跑起来

前提：

- 本机已安装 Node.js 20+
- 本机已安装 `codex`
- 你有可用的方舟 API Key

### 1. 安装依赖

```bash
cd /Users/bytedance/Code/arkclaw-hermes/codex-ark-proxy
npm install
```

### 2. 配置代理环境变量

编辑当前目录下的 `.env`，至少确认这几个字段：

```dotenv
PROXY_HOST=127.0.0.1
PROXY_PORT=8787
LOG_LEVEL=info

ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_API_KEY=你的方舟 API Key
ARK_MODEL_DEFAULT=doubao-seed-2-0-pro-260215
```

### 3. 修复 Codex 本地模型缓存

这一步是为了让 Codex 正确认出 `doubao` 模型，避免 fallback metadata 告警。

```bash
npm run repair-model-cache
```

### 4. 准备独立的 `CODEX_HOME`

```bash
mkdir -p ~/.codex-arkproxy
cp ~/.codex/config.toml ~/.codex-arkproxy/config.toml
cp ~/.codex/auth.json ~/.codex-arkproxy/auth.json
```

把 `~/.codex-arkproxy/config.toml` 改成下面这种关键配置：

```toml
model_provider = "codex"
model = "doubao-seed-2-0-pro-260215"
model_reasoning_effort = "medium"
model_reasoning_summary = "auto"
approval_policy = "never"
sandbox_mode = "danger-full-access"
disable_response_storage = true

[model_providers.codex]
name = "codex"
base_url = "http://127.0.0.1:8787"
wire_api = "responses"
```

### 5. 启动代理

```bash
cd /Users/bytedance/Code/arkclaw-hermes/codex-ark-proxy
npm run build
npm start
```

### 6. 启动 Codex

非搜索 smoke：

```bash
CODEX_HOME=$HOME/.codex-arkproxy codex exec -C /Users/bytedance/Code/arkclaw-hermes --model doubao-seed-2-0-pro-260215 "Reply with exactly: smoke-ok"
```

带搜索的真实回归：

```bash
CODEX_HOME=$HOME/.codex-arkproxy codex --search exec -C /Users/bytedance/Code/arkclaw-hermes --model doubao-seed-2-0-pro-260215 "帮我看看今天github发布了什么特别的火热项目"
```

如果你想做成固定命令，可以加 alias：

```bash
alias codex-arkproxy='CODEX_HOME=$HOME/.codex-arkproxy codex'
```

## 代理自检

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/v1/models
curl -X POST http://127.0.0.1:8787/responses \
  -H 'content-type: application/json' \
  -d '{"model":"doubao-seed-2-0-pro-260215","input":"Reply with exactly: ok"}'
```

## 测试

类型检查：

```bash
npm run check
```

全量自动测试：

```bash
npm test
```

当前测试覆盖：

- 配置解析
- 模型映射
- 请求净化
- `input.status` 回放兼容
- SSE 事件顺序
- `/healthz`
- `/v1/models`
- 鉴权和错误路径

## 已知情况

- Codex 客户端有时会打印：
  `failed to record rollout items: thread ... not found`
  这是客户端本地 rollout 持久化问题，不影响代理转发和回答结果。
- 普通 TUI 是否完整展示 reasoning / tool trace，取决于 Codex 客户端自身展示策略；但代理侧事件已兼容到 Codex 内核可识别的形状。
