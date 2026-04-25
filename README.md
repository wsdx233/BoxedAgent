# BoxedAgent

BoxedAgent 是一个基于 Docker 的 agent + sandbox 平台：每个 **Box** 对应一个 Ubuntu 24.04 开发容器，容器内运行基于 **pi mono** 的 agent RPC；平台提供 HTTP API 与 Web UI，可同时管理多个 Box、多个活跃 Session、容器 Shell、文件浏览器、code-server 和每个 Box 独立的 pi 配置。

## 当前能力

- Box 管理：创建、启动、停止、克隆、修改、删除 Docker 容器/镜像。
- 镜像保障：默认镜像 `boxedagent/ubuntu-dev:24.04` 不存在时，后端会自动用 `docker/box.Dockerfile` 构建；非默认镜像会尝试 `docker pull`。
- 默认 Box 镜像：Ubuntu 24.04 + curl/wget/git/python3/ripgrep/fd/nvm/node/pi/code-server 等开发工具。
- Agent：容器内通过 `pi --mode rpc` 运行；支持多 Session、流式事件、文本与图片输入、中止、steer/follow-up 队列消息。
- Session 持久化：pi session 文件保存在 Box workspace 的 `/workspace/.pi-sessions`，重启后会继续使用已有 session file。
- 每 Box 独立 pi 配置：独立 `PI_CODING_AGENT_DIR=/workspace/.boxedagent/pi-agent`，支持 `settings.json`、`models.json`、`SYSTEM.md`、`APPEND_SYSTEM.md`、`AGENTS.md`、默认 provider/model/thinking、enabledModels 与环境变量。
- Web UI：左侧 Box/Session 管理，中间 ChatGPT 风格对话，右侧 Shell 终端、文件浏览器（上传/下载/删除）、Pi 配置面板、code-server 代理入口。
- API first：Web/桌面/移动客户端都可复用同一套 REST + WebSocket API。

## 快速开始（本机开发）

要求：Node.js >= 22、Docker daemon、npm。

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY / OPENAI_API_KEY 等
# 如果要通过公网访问，请务必设置 BOXEDAGENT_TOKEN，例如：openssl rand -base64 32
npm run build
npm start
```

访问 <http://localhost:8080>。

开发模式：

```bash
npm run dev      # API: http://localhost:8080
npm run dev:web  # Web: http://localhost:5173
```

> 默认镜像无需手动构建；第一次创建/启动 Box 时会自动构建。你也可以提前执行：
>
> ```bash
> npm run docker:build-box
> ```

如果你之前运行过旧版本，建议重启服务并清理失败的测试 Box；旧版因缺少默认镜像产生的 `error` Box 现在可以直接点启动触发自动构建，也可以删除后重新创建。

## Docker Compose 部署

```bash
cp .env.example .env
# 编辑 .env，至少填入：
# BOXEDAGENT_TOKEN=$(openssl rand -base64 32)
# SESSION_SECRET=$(openssl rand -base64 32)
# 可选：如果放在 HTTPS 反向代理后，设置 PUBLIC_ORIGIN=https://your-domain.example
npm run docker:build-box
sudo mkdir -p /var/lib/boxedagent
sudo chown -R "$USER:$USER" /var/lib/boxedagent
docker compose up --build -d
```

> 注意：服务通过宿主机 Docker socket 创建子 Box 容器，`DATA_DIR` 必须是宿主机和服务容器都能访问的相同绝对路径。默认 compose 使用 `/var/lib/boxedagent`。

## Pi 配置模型

每个 Box 会把配置写入 workspace：

```text
/workspace/.boxedagent/pi-agent/settings.json
/workspace/.boxedagent/pi-agent/models.json
/workspace/.boxedagent/pi-agent/AGENTS.md
/workspace/.pi/SYSTEM.md
/workspace/.pi/APPEND_SYSTEM.md
/workspace/.pi-sessions/*.jsonl
```

agent 进程通过环境变量使用独立目录：

```bash
PI_CODING_AGENT_DIR=/workspace/.boxedagent/pi-agent
```

因此不同 Box 可以使用完全不同的模型、代理、自定义 provider 和提示词。

### models.json 示例：Ollama / OpenAI 兼容服务

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen2.5-coder:7b", "name": "Qwen Coder Local", "contextWindow": 128000 }
      ]
    }
  }
}
```

在 Web UI 右侧 `Pi` 标签页可编辑这些配置。

## API 概览

如果设置了 `BOXEDAGENT_TOKEN`，除 `/api/auth/status`、`/api/auth/login`、`/api/auth/logout` 和 `/api/health` 外，API、WebSocket、terminal 与 code-server 代理都需要认证。浏览器登录后会获得 HttpOnly Cookie；脚本也可使用：

```bash
curl -H "Authorization: Bearer $BOXEDAGENT_TOKEN" http://localhost:8080/api/boxes
```

### Auth

- `GET /api/auth/status`
- `POST /api/auth/login`：`{ "token": "..." }`
- `POST /api/auth/logout`

### 镜像

- `GET /api/images/status?image=boxedagent%2Fubuntu-dev%3A24.04`
- `POST /api/images/ensure`：检查并构建/拉取镜像。

### Box

- `GET /api/boxes`
- `POST /api/boxes`
- `PATCH /api/boxes/:boxId`
- `POST /api/boxes/:boxId/start`
- `POST /api/boxes/:boxId/stop`
- `POST /api/boxes/:boxId/clone`
- `DELETE /api/boxes/:boxId?force=true&deleteWorkspace=false`

创建示例：

```json
{
  "name": "frontend-box",
  "image": "boxedagent/ubuntu-dev:24.04",
  "enableCodeServer": true,
  "codeServerPassword": "boxedagent",
  "pi": {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-5",
    "defaultThinkingLevel": "medium"
  },
  "autostart": true
}
```

### Box Pi 配置

- `GET /api/boxes/:boxId/pi-config`
- `PUT /api/boxes/:boxId/pi-config`

```json
{
  "defaultProvider": "ollama",
  "defaultModel": "qwen2.5-coder:7b",
  "defaultThinkingLevel": "medium",
  "enabledModels": ["qwen*", "claude-*"],
  "settingsJsonText": "{\"transport\":\"sse\"}",
  "modelsJsonText": "{\"providers\":{}}",
  "systemPrompt": "",
  "appendSystemPrompt": "你是这个 Box 的专用开发 Agent。",
  "agentsMd": "常用命令：npm test",
  "env": {
    "ANTHROPIC_API_KEY": "..."
  }
}
```

### Session / Agent

- `GET /api/sessions?boxId=...`
- `POST /api/sessions`
- `POST /api/sessions/:sessionId/start`
- `POST /api/sessions/:sessionId/prompt`
- `POST /api/sessions/:sessionId/abort`
- `GET /api/sessions/:sessionId/messages`

Prompt 示例：

```json
{
  "message": "请查看当前项目并运行测试",
  "streamingBehavior": "steer"
}
```

图片输入：`images: [{ "type":"image", "data":"base64...", "mimeType":"image/png" }]`。

### WebSocket

- `/ws/events`：全局事件。
- `/ws/boxes/:boxId/events`：Box 事件。
- `/ws/sessions/:sessionId/events`：agent RPC 流式事件。
- `/ws/boxes/:boxId/terminal`：交互式 Shell。

### 文件

- `GET /api/boxes/:boxId/files?path=.`
- `GET /api/boxes/:boxId/files/download?path=...`
- `POST /api/boxes/:boxId/files/upload?path=...` multipart `file`
- `POST /api/boxes/:boxId/files/mkdir`
- `DELETE /api/boxes/:boxId/files?path=...`

## 安全建议

BoxedAgent 会让 agent 在容器中执行命令。生产环境请至少做到：

1. 必须设置长随机 `BOXEDAGENT_TOKEN`；`NODE_ENV=production` 且未设置 token 时服务会拒绝启动。
2. 建议同时设置随机 `SESSION_SECRET`，并通过 HTTPS 反向代理访问；如有公网域名，设置 `PUBLIC_ORIGIN=https://...`。
3. 更高安全等级下，仍建议放在 VPN、SSO 或反向代理认证后，并限制来源 IP。
4. 为不同用户隔离 `DATA_DIR`、Docker network 与镜像权限。
5. 对 Box 增加 CPU/内存限制，并按需加只读挂载、seccomp/AppArmor 策略。
6. 谨慎传递 API Key；默认会把服务环境中的常见 LLM API Key 继承到新 Box。
7. 定期清理克隆镜像和 workspace。
8. 暴露 Docker socket 等同宿主机 root 能力；生产部署建议用专用宿主机或更严格的容器运行时策略。

## 项目结构

```text
server/                 Fastify API、Docker 管理、pi RPC runtime、WebSocket
web/                    React + Vite Web UI
docker/box.Dockerfile   默认 Ubuntu 开发 sandbox 镜像
Dockerfile              BoxedAgent 服务镜像
docker-compose.yml      生产部署示例
```
