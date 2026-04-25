# codex-ark-proxy

让本机 `codex` 直接跑在 Ark / Doubao 上的本地兼容代理。

它把 Codex 发出的 OpenAI Responses 请求转成 Ark OpenAI-compatible 请求，同时补齐一层兼容逻辑，解决直接对接时常见的几个问题：

- Doubao 模型元数据缺失，Codex 只能走 fallback metadata
- Ark 不接受部分 Codex 私有字段
- 流式 SSE 事件形状和原生 Responses 不完全一致
- 回放型输入缺失 `input.status` 时会被 Ark 拒绝

这套代理的目标不是“能通一次”，而是让本机日常用 `codex` 时，尽量接近原生体验。

## 已支持能力

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /responses`
- 模型映射与默认模型回退
- `web_search` / `function` 工具透传
- Responses SSE 兼容回放
- `reasoning` / `function_call` / `message` 事件拼装
- 回放场景 `input.status` 自动补齐

## 一键装好

仓库里提供了一个安装脚本：[bootstrap-codex-ark.sh](/Users/bytedance/Code/arkclaw-hermes/codex-ark-proxy/bootstrap-codex-ark.sh)

本地执行：

```bash
curl -fsSL https://haoxingjun-test.tos-cn-beijing.volces.com/bootstrap-codex-ark.sh | ARK_API_KEY=你的方舟Key bash
```

这个脚本会自动完成：

- 拉取或更新仓库到本地安装目录
- 安装依赖
- 构建代理
- 初始化当前目录 `.env`
- 初始化独立的 `~/.codex-arkproxy`
- 写入 Codex 所需的代理配置
- 修复 Doubao 模型缓存
- 生成 `codex-arkproxy` 启动命令
- 注册并启动本地后台代理

后台服务策略：

- macOS: `launchd`
- Linux:
  - 优先 `systemd --user`
  - root 场景优先系统级 `systemd`
  - 再不行退化到 `nohup`

前提只有三个：

- 已安装 Node.js 20+
- 已安装 `codex`
- 有可用的 Ark API Key

安装完成后，不需要再手动 `npm start`，代理会作为本地常驻服务启动。

## 最短使用路径

安装：

```bash
curl -fsSL https://haoxingjun-test.tos-cn-beijing.volces.com/bootstrap-codex-ark.sh | ARK_API_KEY=你的方舟Key bash
```

直接使用：

```bash
codex-arkproxy --model doubao-seed-2-0-pro-260215
```

如果当前 shell 里还找不到 `codex-arkproxy`，再执行一次新的登录 shell：

```bash
exec "$SHELL" -l
```

如果你只想验证代理是否在线：

```bash
curl http://127.0.0.1:8787/healthz
```

## 验证方式

非搜索 smoke：

```bash
codex-arkproxy exec -C /Users/bytedance/Code/arkclaw-hermes --model doubao-seed-2-0-pro-260215 "Reply with exactly: smoke-ok"
```

带搜索的真实回归：

```bash
codex-arkproxy --search exec -C /Users/bytedance/Code/arkclaw-hermes --model doubao-seed-2-0-pro-260215 "帮我看看今天 github 发布了什么特别火热的项目"
```

代理自检：

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/v1/models
```

## 手动安装

如果你不想走一键脚本，仓库里也保留了手动方式。

1. 安装依赖

```bash
cd /Users/bytedance/Code/arkclaw-hermes/codex-ark-proxy
npm install
```

2. 配置 `.env`

```dotenv
PROXY_HOST=127.0.0.1
PROXY_PORT=8787
LOG_LEVEL=info

ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_API_KEY=你的方舟 API Key
ARK_MODEL_DEFAULT=doubao-seed-2-0-pro-260215
```

3. 修复模型缓存

```bash
npm run repair-model-cache
```

4. 准备独立 `CODEX_HOME`

```bash
mkdir -p ~/.codex-arkproxy
cp ~/.codex/config.toml ~/.codex-arkproxy/config.toml
cp ~/.codex/auth.json ~/.codex-arkproxy/auth.json
```

`~/.codex-arkproxy/config.toml` 关键配置：

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

5. 手动启动代理

```bash
cd /Users/bytedance/Code/arkclaw-hermes/codex-ark-proxy
npm start
```

6. 手动启动 Codex

```bash
CODEX_HOME=$HOME/.codex-arkproxy codex --model doubao-seed-2-0-pro-260215
```

## 开发

目录结构：

- `src/`: 代理实现
- `scripts/repair-model-cache.mjs`: 修复 Codex 本地 Doubao 模型元数据
- `test/`: 单测和路由集成测试

本地检查：

```bash
npm run check
npm test
```

当前自动化覆盖包括：

- 配置解析
- 模型映射
- Ark 不兼容字段净化
- `input.status` 回放兼容
- SSE 事件顺序与结构
- `/healthz`
- `/v1/models`
- 鉴权和错误路径

## 已知情况

- Codex 客户端有时会打印 `failed to record rollout items: thread ... not found`。这是客户端本地 rollout 持久化问题，不影响代理请求和结果。
- 普通 TUI 是否完整展示 reasoning / tool trace，最终还取决于 Codex 客户端自己的展示策略；代理侧已经尽量把事件序列收敛到可识别格式。
