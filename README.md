# dsh-llm-qwen

让 DeepSeek Harness 使用通义千问（Qwen / DashScope）API 的 LLM 适配器插件，可分发。

在 `ctx.llm` 上注册 `qwen` provider 路由，走 DashScope 的
OpenAI 兼容协议（`https://dashscope.aliyuncs.com/compatible-mode/v1`），
与 `dsh-llm-deepseek` 同一套架构：传输层适配器 + 每请求解析的连接事实/密钥。
**插件内不含任何 API key，密钥完全由用户在界面或凭证文件里管理。**

## 能力

- 流式对话（`stream_options.include_usage`，token 用量上报）
- Qwen3 思考模式：`enable_thinking` + `reasoning_effort`（off/high/max 三档，
  网关还支持 low/medium），思考内容经 `delta.reasoning_content` 流入 harness 的
  reasoning 块
- 工具调用（`delta.tool_calls` + `finish_reason: tool_calls`，含多轮工具结果回传）
- 图片输入（qwen3.5+/3.6/3.7/3.8 与 qwen3-vl 系列原生支持；user 内容转 `image_url` data-URL，经 attachments 服务读取）
- **图片任务自动路由**：所选模型不支持图片（如 DeepSeek/GLM/Kimi）时，带图请求自动改由
  配置的多模态模型处理（默认 `qwen3.8-max`，可在设置页或 `llm-qwen:` settings 段修改，
  留空关闭）；前端模型名不变，仅 wire 层换模型
- 错误映射：401/403→`AUTH`、429→`RATE_LIMIT`、余额不足→`QUOTA`、
  上下文超限→`CONTEXT_WINDOW_EXCEEDED`、5xx→`SERVER`
- 流空闲看门狗、LLM 重试策略（`llm/stream` waterfall 兼容）

## 安装

1. 把本包（`dsh-llm-qwen/`）放进 profile 的 node_modules：
   `cp -r dsh-llm-qwen ~/.dsh/profiles/node_modules/`
2. 在 profile 补丁 `~/.dsh/profiles/web/cordis.patch.yml` 里加一行
   （**注意：新增行必须用 `insert:` 包裹**；裸 `- id:` 只能覆盖已存在的行，
   目标不存在会被静默丢弃）：

```yaml
- insert:
    - id: llm-qwen
      name: 'dsh-llm-qwen'
      config:
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        thinking: enabled
        reasoningEffort: high
```

3. 重启 `dsh web`。重启后 设置→模型 里出现 **Qwen (DashScope)** 提供商。

## 密钥：在前端填写，绝不进插件

插件自带前端设置页（client 半边，`dsh.client` 双端包）：

- **设置 → Qwen (DashScope)**：API Key 输入框 + 已配置/未配置状态，保存即写入
  `~/.dsh/.credentials.yaml` 的 `DASHSCOPE_API_KEY`（插件默认凭证引用名），
  每请求实时读取，改完立即生效，无需重启。
- 也可以手动编辑 `~/.dsh/.credentials.yaml`，或导出环境变量
  `DASHSCOPE_API_KEY`（环境变量优先级最高）。
- 想换一个凭证引用名：在 `settings.yaml` 加 `llm-qwen: { apiKeyEnv: 别的名字 }`，
  再把 key 存到那个名字下即可。

> 说明：设置→模型 页只对 `llm-deepseek` / `llm-pi-ai` 两个内置命名空间提供内联编辑，
> 第三方插件在那里的行只会显示"其余字段在 settings.yaml 中"的提示（产品写死）。
> 因此插件的 key 管理入口放在自己注册的设置页里，与 Models 页走同一套凭证服务。

## 模型目录（默认 17 个）

Qwen3 全家 + 网关提供的第三方模型，选择器里直接可选（上下文窗口按官方规格标注）：

- Qwen（1M 上下文）：`qwen3.8-max`、`qwen3.7-max`、`qwen3.7-flash`、`qwen3.6-plus`、`qwen3.6-flash`
- Qwen（256K 上下文）：`qwen3-coder-plus`、`qwen3-coder-flash`、`qwen3-vl-plus`（图）、`qwen3-vl-flash`（图）
- 第三方（经千问网关）：`deepseek-v4-flash`（预览版，1M）、`deepseek-v4-flash-0731`（正式版，1M）、
  `deepseek-v4-pro`（预览版，1M）、`deepseek-v4-pro-0813`（正式版，1M）、`deepseek-v3.2`（128K）、
  `glm-5.2`、`glm-5.2-fast-preview`、`glm-5.1`（均为 128K）、`kimi-k2.7-code`（256K）

网关共提供 238 个模型 id，想用目录外的：在 `settings.yaml` 加 `llm-qwen:` 段：

```yaml
llm-qwen:
  models:
    - { id: qwen3.5-omni-plus, name: 'Qwen3.5 Omni Plus' }
    - { id: MiniMax/MiniMax-M3, name: 'MiniMax M3' }   # 需先在该账号开通对应产品
```

适配器不校验模型 id，未开通的产品会在请求时报 400「product is not activated」。

## 配置（`llm-qwen:` settings 段，热更新，可省略全部）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `DASHSCOPE_API_KEY` | 凭证引用名（Models 页填的 key 就存这里） |
| `baseURL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 兼容模式端点 |
| `thinking` | `enabled` | 是否默认启用思考 |
| `reasoningEffort` | `high` | `off` / `high` / `max` |
| `maxTokens` | `16384` | 默认输出上限 |
| `defaultContextWindow` | `131072` | 未在目录中列出的模型的默认上下文窗口 |
| `models` | 见 `DEFAULT_MODELS` | 模型目录（id/name/contextWindow/maxTokens/inputModalities） |
| `multiModalFallbackModel` | `qwen3.8-max` | 图片任务的自动路由目标；留空（`""`）关闭 |
| `streamIdleTimeoutMs` | `300000` | 流空闲超时 |
| `retryPolicy` | 标准重试 | 见 `@deepseek-ai/dsh-llm` |

## 测试

`node test/e2e.mjs`（用 `DASHSCOPE_API_KEY`/`QWEN_DASHSCOPE_API_KEY` 环境变量或
`~/test_qwen_api.txt` 里的 key，直连真实网关）：

- 流式对话、思考流、工具调用、工具结果回传、qwen-vl 图片输入、401 错误映射、
  模型元数据、schemastery 归一化配置回归、第三方模型（deepseek-v4-flash）经网关直连
  —— 28 项全过（qwen3.7-flash、qwen3.8-max、deepseek-v4-flash 均已验证）。
