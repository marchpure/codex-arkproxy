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
