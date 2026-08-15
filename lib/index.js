/**
 * dsh-llm-qwen — Qwen (DashScope) LLM adapter plugin for DeepSeek Harness.
 *
 * Registers a `qwen` provider route on `ctx.llm` that speaks DashScope's
 * OpenAI-compatible chat-completions protocol
 * (`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`):
 *
 *  - streaming chat completions with `stream_options.include_usage`,
 *  - Qwen3 thinking via `enable_thinking` (reasoning streams as
 *    `delta.reasoning_content`, matching the DeepSeek wire convention),
 *  - OpenAI-shaped tool calls (`delta.tool_calls` with `finish_reason:
 *    "tool_calls"`),
 *  - image content for the qwen3-vl models (user content becomes
 *    `image_url` data-URL parts resolved through the attachments service).
 *
 * The adapter is transport-only, mirroring dsh-llm-deepseek: connection
 * facts arrive through a thunk resolved per request, the bearer token
 * through a per-request resolver, and image bytes through the attachments
 * service, so the registering plugin owns validation, layering, and
 * credential policy.
 *
 * @module dsh-llm-qwen
 */
import z from "@deepseek-ai/schemastery";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  RetryPolicySchema,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import { EventSourceParserStream } from "eventsource-parser/stream";

/* ─────────────────────────── wire serialization ─────────────────────────── */

/** Validate the adapter-owned effort before resolving its Qwen wire field. */
function reasoningEffort(effort) {
  if (effort === "off" || effort === "high" || effort === "max") return effort;
  throw new LlmError(`Qwen does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}

/**
 * Resolve one legal thinking/effort pair. Qwen3 thinking is enabled through
 * `enable_thinking` and its depth is tunable with `reasoning_effort`
 * (the gateway accepts low/medium/high/max; the adapter exposes the
 * DeepSeek-convention set off/high/max). `off` is an explicit contradiction
 * on the wire (`enable_thinking: true` + `reasoning_effort: "off"` is
 * rejected with 400), so it serializes as `enable_thinking: false` alone.
 * Session titles never think (fast and cheap).
 */
function resolveThinking(options, defaults) {
  if (options.purpose === "session-title") return { enableThinking: false };
  const effort = options.reasoningEffort === undefined ? defaults.reasoningEffort : reasoningEffort(options.reasoningEffort);
  if (defaults.thinking === "disabled" && effort !== undefined && effort !== "off") {
    throw new LlmError(`Qwen deployment does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
  }
  if (effort === "off") return { enableThinking: false };
  return { enableThinking: true, reasoningEffort: effort };
}

/** Join the text blocks of a message (used for system/tool content). */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

/** Join reasoning blocks of a message. */
function reasoningText(blocks) {
  return blocks.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
}

/** Serialize assistant tool-call blocks into the OpenAI wire shape. */
function toolCallsOf(blocks) {
  return blocks.filter((block) => block.type === "tool-call").map((block) => ({
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: block.arguments },
  }));
}

/** Reject image content inside tool-result blocks (tool content is text-only on the wire). */
function assertToolResultTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError("The Qwen chat-completions adapter does not support image content inside tool results.", "UNSUPPORTED_CONTENT");
  }
}

/**
 * Serialize one assistant message. Qwen's chat template consumes the
 * previous assistant turn's `reasoning_content` whenever thinking is enabled
 * for the current request, so reasoning is replayed on every thinking turn
 * (not only tool-call turns, unlike DeepSeek's policy).
 */
function serializeAssistant(message, includeReasoning) {
  const text = flattenText(message.content);
  const reasoning = reasoningText(message.content);
  const toolCalls = toolCallsOf(message.content);
  return {
    role: "assistant",
    content: text,
    ...(includeReasoning && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Serialize user-role content. Text blocks become a plain string when alone
 * (or text parts in a multi-part array); image blocks become OpenAI-style
 * `image_url` data-URL parts resolved through the adapter's image resolver.
 */
async function serializeUserContent(blocks, resolveImage, signal) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const data = await resolveImage(block.attachment, signal);
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.attachment.mediaType};base64,${Buffer.from(data).toString("base64")}` },
      });
    }
  }
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text/images
 * first and its tool results as separate wire messages after.
 */
async function serializeMessages(messages, includeReasoning, resolveImage, signal) {
  const wire = [];
  for (const message of messages) {
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message, includeReasoning));
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const userBlocks = message.content.filter((block) => block.type === "text" || block.type === "image");
    if (userBlocks.length > 0) {
      wire.push({ role: "user", content: await serializeUserContent(userBlocks, resolveImage, signal) });
    } else if (toolResults.length === 0) {
      wire.push({ role: "user", content: "" });
    }
    for (const result of toolResults) {
      assertToolResultTextOnly(result.content);
      wire.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || "(no output)",
      });
    }
  }
  return wire;
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply. `enable_thinking` is sent only when the route
 * declares thinking support; with `thinking: disabled` the param is omitted
 * and the gateway default (thinking off) applies.
 */
async function serializeRequest(options, defaults, resolveImage, signal) {
  const messages = [];
  if (options.system !== undefined) messages.push({ role: "system", content: options.system });
  const resolvedThinking = resolveThinking(options, defaults);
  messages.push(...(await serializeMessages(options.messages, resolvedThinking.enableThinking, resolveImage, signal)));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(defaults.thinking === "enabled" ? { enable_thinking: resolvedThinking.enableThinking } : {}),
    ...(defaults.thinking === "enabled" && resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  };
}

/* ─────────────────────────── SSE parsing / translation ──────────────────── */

/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it (truncated response — the model call cannot be trusted).
 */
async function* parseSse(stream, onComment) {
  const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
  for await (const { data } of events) {
    yield data;
    if (data === "[DONE]") return;
  }
  throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}

/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * Unrecognized values (content_filter, …) become `{kind: 'error'}`.
 */
function mapFinishReason(reason) {
  switch (reason) {
    case "stop": return { kind: "stop" };
    case "tool_calls": return { kind: "tool-calls" };
    case "length": return { kind: "max-tokens" };
    default: return { kind: "error", failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
  }
}

/**
 * Map wire usage fields. DashScope reports disjoint-ish counts:
 * `prompt_tokens_details.cached_tokens` and
 * `completion_tokens_details.reasoning_tokens`, which map straight onto the
 * harness TokenUsage convention (cache reads subtracted from inputTokens).
 */
function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
  switch (block.kind) {
    case "text": return { type: "text", text: block.text };
    case "reasoning": return { type: "reasoning", text: block.text };
    case "tool-call": return { type: "tool-call", id: CallId(block.callId ?? ""), name: block.name ?? "", arguments: block.text };
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield harness
 * StreamChunks. Malformed JSON payloads abort the stream with
 * `MALFORMED_RESPONSE`. `block-end`s, `usage`, and `finish` are all deferred
 * to the `[DONE]` sentinel.
 */
async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;
  function open(kind) {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  }
  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      for (const block of order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      const reason = pendingFinish ?? { kind: "stop" };
      yield {
        type: "finish",
        reason: reason.kind === "stop" && order.length === 0
          ? { kind: "error", failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE } }
          : reason,
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        // DashScope emits `id`/`name` only on the first delta of a call and
        // sends empty strings on subsequent fragments; only non-empty values
        // may overwrite the accumulated identity.
        if (typeof call.id === "string" && call.id.length > 0) block.callId = call.id;
        if (typeof call.function?.name === "string" && call.function.name.length > 0) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: CallId(block.callId ?? ""),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        };
      }
      if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}

/* ─────────────────────────────── the adapter ────────────────────────────── */

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";

const OFF_REASONING_EFFORT = ReasoningEffortId("off");
const HIGH_REASONING_EFFORT = ReasoningEffortId("high");
const MAX_REASONING_EFFORT = ReasoningEffortId("max");
// The gateway also accepts `low`/`medium`; the adapter exposes the
// DeepSeek-convention set off/high/max.
const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: "Off" },
  { id: HIGH_REASONING_EFFORT, name: "High" },
  { id: MAX_REASONING_EFFORT, name: "Max" },
];
const OFF_ONLY_REASONING_EFFORTS = [{ id: OFF_REASONING_EFFORT, name: "Off" }];

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: model.inputModalities ?? ["text"],
  };
}

function providerRetryAfterMs(value) {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1e3;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function requestId(headers, error) {
  return error?.request_id ?? headers.get("x-request-id") ?? undefined;
}

/**
 * Map an HTTP status to a stable LlmError code. DashScope error bodies carry
 * `{error: {code, message, request_id}}`; quota exhaustion is also signalled
 * by the `InsufficientBalance` code on non-429 statuses.
 */
function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return "AUTH";
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
  if (isQuotaExceededError(detail) || error?.code === "InsufficientBalance") return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/**
 * The Qwen adapter. One instance serves every model name it was registered
 * under (the harness model name IS the wire model name). One stable signal
 * reaches both initial fetch and body reads; caller aborts map to `ABORTED`
 * and the configured per-read idle watchdog maps to `TIMEOUT`.
 */
class QwenAdapter extends LlmAdapter {
  config;
  constructor(config) {
    super();
    this.config = config;
  }
  providerInfo(provider) {
    return { id: provider, name: "Qwen" };
  }
  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }
  listModels(provider) {
    return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
  }
  resolveModel(provider, model, _signal) {
    const connection = this.config.options();
    const configured = connection.models.find((entry) => entry.id === model);
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
    return Promise.resolve({
      ...(configured === undefined
        ? { provider, id: model, name: model, inputModalities: ["text"] }
        : modelInfo(provider, configured)),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...(connection.defaults.thinking === "disabled"
        ? { reasoning: { efforts: OFF_ONLY_REASONING_EFFORTS, defaultEffort: OFF_REASONING_EFFORT } }
        : {
            reasoning: {
              efforts: REASONING_EFFORTS,
              defaultEffort: connection.defaults.reasoningEffort === "off" ? OFF_REASONING_EFFORT : HIGH_REASONING_EFFORT,
            },
          }),
    });
  }
  async *stream(options) {
    const consumer = new AbortController();
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    const watchdog = idleWatchdog(signal, this.config.options().streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE);
    const iterator = this.request(options, watchdog.signal)[Symbol.asyncIterator]();
    let exhausted = false;
    try {
      while (true) {
        const result = await watchdog.next(iterator);
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`Qwen stream idle timeout after ${this.config.options().streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      }
      if (options.signal?.aborted) throw new LlmError("Qwen request aborted by caller", "ABORTED", { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`Qwen API stream from ${this.config.options().baseURL} failed`, "TRANSPORT", { cause: error });
    } finally {
      consumer.abort("Qwen stream consumer stopped");
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return();
        } catch (_abortedTransportTeardown) {}
      }
    }
  }
  async *request(options, signal) {
    const connection = this.config.options();
    const apiKey = await this.config.resolveApiKey(connection);
    const body = await serializeRequest(options, connection.defaults, this.config.resolveImage, signal);
    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      ...attributionHeaders(),
    };
    let response;
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new LlmError(`Qwen API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    }
    if (!response.ok) {
      let message = `Qwen API error (HTTP ${response.status})`;
      let providerError;
      try {
        providerError = (await response.json()).error;
        if (providerError?.message) message = providerError.message;
      } catch {}
      const delay = providerRetryAfterMs(response.headers.get("retry-after"));
      const id = requestId(response.headers, providerError);
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        ...(id === undefined ? {} : { requestId: id }),
      });
    }
    if (!response.body) throw new LlmError("Qwen API returned no response body", "EMPTY_RESPONSE");
    yield* translate(parseSse(response.body, () => {}));
  }
}

/* ─────────────────────────── plugin registration ────────────────────────── */

const name = "llm-qwen";
const inject = ["llm"];
const NS = settingsNamespace("llm-qwen");
const DEFAULT_API_KEY_ENV = "DASHSCOPE_API_KEY";
const PROVIDER = "qwen";
const PUBLIC_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 16384;

/**
 * Advisory catalog, aligned with the models this gateway serves. Qwen3
 * models plus the gateway's third-party chat/coding models that the test
 * account can actually call (deepseek, glm, kimi). Any of the gateway's 238
 * model ids can be added here (or through an `llm-qwen:` settings section);
 * the adapter never rejects unlisted ids — the picker just needs them listed
 * to make them selectable.
 */
const DEFAULT_MODELS = [
  { id: "qwen3.8-max", name: "Qwen3.8 Max", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "qwen3.7-max", name: "Qwen3.7 Max", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "qwen3.7-flash", name: "Qwen3.7 Flash", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "qwen3.6-flash", name: "Qwen3.6 Flash", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "qwen3-coder-flash", name: "Qwen3 Coder Flash", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "qwen3-vl-plus", name: "Qwen3 VL Plus", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: ["text", "image"] },
  { id: "qwen3-vl-flash", name: "Qwen3 VL Flash", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: ["text", "image"] },
  // Third-party models served through the DashScope gateway.
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (via Qwen)", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731 正式版 (via Qwen)", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (via Qwen)", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro 0813 正式版 (via Qwen)", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "deepseek-v3.2", name: "DeepSeek V3.2 (via Qwen)", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "glm-5.2", name: "GLM-5.2 (via Qwen)", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "glm-5.2-fast-preview", name: "GLM-5.2 Fast Preview (via Qwen)", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "glm-5.1", name: "GLM-5.1 (via Qwen)", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code (via Qwen)", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
];

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(["text", "image"])),
});

const Config = z.object({
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  thinking: z.union(["enabled", "disabled"]),
  reasoningEffort: z.union(["off", "high", "max"]).default("high"),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
  const seen = new Set();
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error("dsh-llm-qwen: catalog model ids must be non-empty");
    if (model.name !== undefined && model.name.length === 0) throw new Error(`dsh-llm-qwen: catalog model "${model.id}" has an empty name`);
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`dsh-llm-qwen: catalog model "${model.id}" contextWindow must be a positive integer`);
    }
    if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`dsh-llm-qwen: catalog model "${model.id}" maxTokens must be a positive integer`);
    }
    // Schemastery materializes `[]` for an absent array field, so an empty
    // list means "not declared", not "accepts nothing" — treat it as absent
    // and let modelInfo default the modality to text.
    const modalities = model.inputModalities !== undefined && model.inputModalities.length > 0 ? model.inputModalities : undefined;
    if (modalities !== undefined && modalities.some((m) => m !== "text" && m !== "image")) {
      throw new Error(`dsh-llm-qwen: catalog model "${model.id}" inputModalities must contain only "text"/"image"`);
    }
    if (seen.has(model.id)) throw new Error(`dsh-llm-qwen: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(modalities === undefined ? {} : { inputModalities: [...modalities] }),
    };
  });
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts (programmatic construction may bypass Schemastery normalization).
 */
function resolveAdapterOptions(config, environment) {
  if (config.thinking === "disabled" && config.reasoningEffort !== undefined && config.reasoningEffort !== "off") {
    throw new Error("dsh-llm-qwen: only reasoningEffort \"off\" can be configured when thinking is disabled");
  }
  if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error("dsh-llm-qwen: defaultContextWindow must be a positive integer");
  }
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error("dsh-llm-qwen: maxTokens must be a positive safe integer");
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-llm-qwen: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL ?? PUBLIC_BASE_URL,
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "dsh-llm-qwen: retryPolicy"),
  };
}

function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error("dsh-llm-qwen: keeping the last good configuration after an invalid settings section");
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();
  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined) return assertUsableApiKey(hit.value, "dsh-llm-qwen", ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "dsh-llm-qwen", ref);
    }
    throw new LlmError(
      `dsh-llm-qwen: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
      "MISSING_CREDENTIAL",
    );
  };
  const resolveImage = async (ref, signal) => {
    const attachments = ctx.get("attachments");
    if (attachments === undefined) {
      throw new LlmError("dsh-llm-qwen: image content requires the attachments service", "UNSUPPORTED_CONTENT");
    }
    const stored = await attachments.readImage(ref, signal);
    return stored.data;
  };
  let userId;
  const resolveUserId = () => (userId ??= getOrCreateAnonymousUserId());
  const adapter = new QwenAdapter({ options, resolveApiKey, resolveUserId, resolveImage });
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: "Qwen (DashScope)", settingsNs: NS, settingsPath: [] },
  ]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: ensureRegistrationFacts,
  });
}

export {
  Config,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  PUBLIC_BASE_URL,
  QwenAdapter,
  apply,
  inject,
  name,
  resolveAdapterOptions,
  resolveThinking,
  serializeRequest,
  translate,
};
