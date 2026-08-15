/**
 * End-to-end test for the dsh-llm-qwen adapter against the real DashScope
 * compatible-mode gateway. Uses the key from ~/test_qwen_api.txt (or the
 * QWEN_DASHSCOPE_API_KEY / DASHSCOPE_API_KEY environment).
 *
 * Run from the package directory:  node test/e2e.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { QwenAdapter, resolveAdapterOptions, DEFAULT_MODELS } from "../lib/index.js";

const BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

function apiKey() {
  for (const name of ["QWEN_DASHSCOPE_API_KEY", "DASHSCOPE_API_KEY"]) {
    if (process.env[name]?.length) return process.env[name];
  }
  try {
    const raw = readFileSync(join(homedir(), "test_qwen_api.txt"), "utf8").trim();
    if (raw.length) return raw;
  } catch {}
  throw new Error("no API key: set QWEN_DASHSCOPE_API_KEY or place it in ~/test_qwen_api.txt");
}

const connection = resolveAdapterOptions({
  apiKeyEnv: "QWEN_DASHSCOPE_API_KEY",
  baseURL: BASE_URL,
  thinking: "enabled",
  reasoningEffort: "high",
  maxTokens: 2048,
  defaultContextWindow: 131072,
  models: DEFAULT_MODELS,
  streamIdleTimeoutMs: 120000,
}, { get: () => undefined });

const adapter = new QwenAdapter({
  options: () => connection,
  resolveApiKey: async () => apiKey(),
  resolveUserId: () => "e2e-test",
  resolveImage: async (ref) => {
    if (ref.mediaType === "image/png") return png32();
    throw new Error(`unexpected media type ${ref.mediaType}`);
  },
});

// 32x32 red PNG (VL models reject images smaller than 10px on a side)
function png32() {
  const w = 32, h = 32;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0;
    }
  }
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolor
  return Uint8Array.from(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

function text(blocks) {
  return blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
}
function reasoning(blocks) {
  return blocks.filter((b) => b.type === "reasoning").map((b) => b.text).join("");
}

async function runStream(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  return { chunks, message: assembler.message(), usage: assembler.usage, finish: assembler.finish };
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const model = process.env.QWEN_TEST_MODEL ?? "qwen3.7-flash";
console.log(`\n=== dsh-llm-qwen e2e (model ${model}) ===`);

// 1. Basic stream, thinking off
{
  console.log("\n[1] basic stream (thinking off)");
  const { message, usage, finish } = await runStream(adapter, {
    provider: "qwen", model,
    system: "You are a terse assistant. Answer in Chinese.",
    messages: [{ role: "user", content: [{ type: "text", text: "1+1等于几？只回答数字" }] }],
    reasoningEffort: "off",
  });
  check("emits text", message.content.some((b) => b.type === "text"), JSON.stringify(text(message.content).slice(0, 60)));
  check("finish stop", finish.kind === "stop", JSON.stringify(finish));
  check("usage present", usage !== undefined, JSON.stringify(usage));
}

// 2. Thinking on → reasoning block precedes text
{
  console.log("\n[2] thinking (enable_thinking)");
  const { message, finish } = await runStream(adapter, {
    provider: "qwen", model,
    messages: [{ role: "user", content: [{ type: "text", text: "9*7等于几？只回答数字" }] }],
    reasoningEffort: "high",
  });
  const r = reasoning(message.content);
  const t = text(message.content);
  check("reasoning emitted", r.length > 0, `reasoning ${r.length} chars`);
  check("text emitted", t.length > 0, JSON.stringify(t.slice(0, 40)));
  const idxR = message.content.findIndex((b) => b.type === "reasoning");
  const idxT = message.content.findIndex((b) => b.type === "text");
  check("reasoning before text", idxR !== -1 && idxT !== -1 && idxR < idxT);
  check("finish stop", finish.kind === "stop", JSON.stringify(finish));
}

// 3. Tool call streaming
{
  console.log("\n[3] tool call");
  const { message, finish } = await runStream(adapter, {
    provider: "qwen", model,
    messages: [{ role: "user", content: [{ type: "text", text: "北京天气怎么样？用工具查" }] }],
    tools: [{ name: "get_weather", description: "查询指定城市的天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
    reasoningEffort: "off",
  });
  const calls = message.content.filter((b) => b.type === "tool-call");
  check("tool call emitted", calls.length > 0);
  check("finish tool-calls", finish.kind === "tool-calls", JSON.stringify(finish));
  if (calls[0]) {
    check("call has id+name+args", calls[0].id.length > 0 && calls[0].name === "get_weather" && calls[0].arguments.includes("北京"), calls[0].arguments);
  }
}

// 4. Round trip: tool call → tool result → follow-up text
{
  console.log("\n[4] tool result round trip");
  const first = await runStream(adapter, {
    provider: "qwen", model,
    messages: [{ role: "user", content: [{ type: "text", text: "北京天气怎么样？用工具查，然后告诉我结果" }] }],
    tools: [{ name: "get_weather", description: "查询指定城市的天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
    reasoningEffort: "off",
  });
  const call = first.message.content.find((b) => b.type === "tool-call");
  if (!call) {
    check("round trip tool call", false, "no tool call in first turn");
  } else {
    const second = await runStream(adapter, {
      provider: "qwen", model,
      messages: [
        { role: "user", content: [{ type: "text", text: "北京天气怎么样？用工具查，然后告诉我结果" }] },
        { role: "assistant", content: [{ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments }] },
        { role: "user", content: [{ type: "tool-result", toolCallId: call.id, content: [{ type: "text", text: "北京：晴，25℃" }] }] },
      ],
      tools: [{ name: "get_weather", description: "查询指定城市的天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
      reasoningEffort: "off",
    });
    const t = text(second.message.content);
    check("follow-up text after tool result", t.length > 0, JSON.stringify(t.slice(0, 60)));
    check("finish stop", second.finish.kind === "stop", JSON.stringify(second.finish));
  }
}

// 5. Image content (qwen3-vl)
{
  const vlModel = process.env.QWEN_VL_TEST_MODEL ?? "qwen3-vl-flash";
  console.log(`\n[5] image content (${vlModel})`);
  const { message, finish } = await runStream(adapter, {
    provider: "qwen", model: vlModel,
    messages: [{ role: "user", content: [
      { type: "text", text: "这张图片是什么颜色？" },
      { type: "image", attachment: { attachmentId: "e2e", mediaType: "image/png", bytes: 68, width: 1, height: 1 } },
    ] }],
    reasoningEffort: "off",
  });
  const t = text(message.content);
  check("emits text", t.length > 0, JSON.stringify(t.slice(0, 80)));
  check("finish stop", finish.kind === "stop", JSON.stringify(finish));
}

// 6. Auth failure
{
  console.log("\n[6] auth failure");
  const bad = new QwenAdapter({
    options: () => connection,
    resolveApiKey: async () => "sk-invalid-key-for-test",
    resolveUserId: () => "e2e-test",
    resolveImage: async () => { throw new Error("unused"); },
  });
  let caught;
  try {
    for await (const _chunk of bad.stream({
      provider: "qwen", model,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      reasoningEffort: "off",
    })) {}
  } catch (error) {
    caught = error;
  }
  check("throws LlmError AUTH", caught?.code === "AUTH", caught ? `${caught.code}: ${caught.message.slice(0, 60)}` : "no throw");
}

// 7. Model metadata
{
  console.log("\n[7] model metadata");
  const info = await adapter.resolveModel("qwen", "qwen3.7-flash");
  check("resolveModel context", info.context?.contextWindow === 1048576, JSON.stringify(info.context));
  check("resolveModel reasoning default", info.reasoning?.defaultEffort === "high", JSON.stringify(info.reasoning));
  const vl = await adapter.resolveModel("qwen", "qwen3-vl-flash");
  check("vl input modalities", JSON.stringify(vl.inputModalities) === JSON.stringify(["text", "image"]), JSON.stringify(vl.inputModalities));
  const generic = await adapter.resolveModel("qwen", "some-unlisted-model");
  check("unlisted model falls back", generic.name === "some-unlisted-model" && generic.reasoning?.defaultEffort === "high");
  const listed = await adapter.listModels("qwen");
  check("listModels", listed.length === DEFAULT_MODELS.length && listed[0].provider === "qwen", `${listed.length} models`);
  const thirdParty = listed.filter((m) => m.id.startsWith("deepseek-") || m.id.startsWith("glm-"));
  check("third-party models in catalog", thirdParty.length >= 2, thirdParty.map((m) => m.id).join(", "));
}

// 7b. Regression: harness normalizes config through Config[~standard].validate
// (Cordis resolveConfig), which materializes `[]` for absent inputModalities.
// resolveAdapterOptions must treat that as "not declared" (text-only), not reject.
{
  console.log("\n[7b] schemastery-normalized config path");
  const { Config } = await import("../lib/index.js");
  const normalized = Config["~standard"].validate({
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    thinking: "enabled",
    reasoningEffort: "high",
  });
  check("schema accepts row config", normalized.issues === undefined, normalized.issues ? JSON.stringify(normalized.issues[0]) : "ok");
  const conn = resolveAdapterOptions(normalized.value, { get: () => undefined });
  check("normalized default catalog", conn.models.length === DEFAULT_MODELS.length, `${conn.models.length} models`);
  const textOnly = conn.models.find((m) => !m.inputModalities);
  const vlModel = conn.models.find((m) => m.id.includes("vl"));
  check("text-only model has no inputModalities", textOnly !== undefined && textOnly.inputModalities === undefined, JSON.stringify(textOnly?.inputModalities));
  check("vl model keeps text+image", JSON.stringify(vlModel?.inputModalities) === JSON.stringify(["text", "image"]), JSON.stringify(vlModel?.inputModalities));
  const adapt = new QwenAdapter({
    options: () => ({ ...conn, streamIdleTimeoutMs: 120000 }),
    resolveApiKey: async () => apiKey(),
    resolveUserId: () => "e2e-test",
    resolveImage: async () => new Uint8Array(0),
  });
  const info = await adapt.resolveModel("qwen", "qwen3.7-flash");
  check("normalized adapter resolves model", info.inputModalities === undefined || JSON.stringify(info.inputModalities) === JSON.stringify(["text"]), JSON.stringify(info.inputModalities));
}

// 8. Third-party model served through the gateway (deepseek / glm)
{
  const tpModel = process.env.QWEN_THIRD_PARTY_TEST_MODEL ?? "deepseek-v4-flash";
  console.log(`\n[8] third-party model via gateway (${tpModel})`);
  const { message, finish } = await runStream(adapter, {
    provider: "qwen", model: tpModel,
    messages: [{ role: "user", content: [{ type: "text", text: "1+1等于几？只回答数字" }] }],
    reasoningEffort: "high",
  });
  const t = text(message.content);
  check("emits text", t.length > 0, JSON.stringify(t.slice(0, 40)));
  check("finish stop", finish.kind === "stop", JSON.stringify(finish));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
