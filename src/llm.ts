// OpenAI 호환 Chat Completions 클라이언트. LM Studio, Ollama, MLX 모두 같은 형식을 쓴다.
import type { ModelConfig } from "./config.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// 메시지 본문 조각. 이미지는 data URL로 보내고, source에는 원래 파일 경로를 둔다(기록용, 모델에는 보내지 않음).
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string }; source?: string };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  message: ChatMessage;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  finishReason?: string;
  raw: unknown;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function chat(
  model: ModelConfig,
  messages: ChatMessage[],
  tools?: ToolSpec[],
  signal?: AbortSignal,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: model.model,
    messages: messages.map(forApi),
    stream: false,
  };
  if (model.temperature !== undefined) body.temperature = model.temperature;
  if (model.reasoningEffort) body.reasoning_effort = model.reasoningEffort;
  if (tools && tools.length > 0) body.tools = tools;

  const timeout = AbortSignal.timeout(model.timeoutMs ?? 600000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const baseUrlClean = model.baseUrl!.replace(/\/$/, "");
  const isAnthropic = baseUrlClean.includes("api.anthropic.com");
  const reqHeaders: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${model.apiKey ?? "local"}`,
  };
  if (isAnthropic && model.apiKey) {
    reqHeaders["x-api-key"] = model.apiKey;
    reqHeaders["anthropic-version"] = "2023-06-01";
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrlClean}/chat/completions`, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new LlmError(`모델 서버 연결 실패 (${model.baseUrl}): ${(err as Error).message}`, true);
  }

  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new LlmError(`모델 서버 오류 ${res.status}: ${text.slice(0, 500)}`, retryable);
  }
  const json = JSON.parse(text);
  const choice = json.choices?.[0];
  if (!choice?.message) throw new LlmError("응답에 message가 없습니다.", true);
  return {
    message: choice.message as ChatMessage,
    usage: json.usage,
    finishReason: choice.finish_reason,
    raw: json,
  };
}

export async function chatWithRetry(
  model: ModelConfig,
  messages: ChatMessage[],
  tools?: ToolSpec[],
  signal?: AbortSignal,
  attempts = 4,
): Promise<ChatResult> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chat(model, messages, tools, signal);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof LlmError) || !err.retryable || signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
  throw lastErr;
}

export async function listModels(model: ModelConfig): Promise<string[]> {
  const baseUrlClean = model.baseUrl!.replace(/\/$/, "");
  const headers: Record<string, string> = { authorization: `Bearer ${model.apiKey ?? "local"}` };
  if (baseUrlClean.includes("api.anthropic.com") && model.apiKey) {
    headers["x-api-key"] = model.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  const res = await fetch(`${baseUrlClean}/models`, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new LlmError(`모델 목록 조회 실패: ${res.status}`, false);
  const json = await res.json();
  return (json.data ?? []).map((m: { id: string }) => m.id);
}

// 본문의 글자 부분만 꺼낸다.
export function textOf(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

// 모델에 보낼 때는 기록용 source를 뺀다.
function forApi(msg: ChatMessage): ChatMessage {
  if (!Array.isArray(msg.content)) return msg;
  return { ...msg, content: msg.content.map((p) => (p.type === "image_url" ? { type: "image_url", image_url: p.image_url } : p)) };
}

// 기록(세션 로그, 파인튜닝 파일)에는 이미지 데이터 대신 파일 경로만 남긴다.
export function forLog(msg: ChatMessage): ChatMessage {
  if (!Array.isArray(msg.content)) return msg;
  return {
    ...msg,
    content: msg.content.map((p) => (p.type === "image_url" ? { type: "image_url", image_url: { url: `ckd-image:${p.source ?? "알 수 없음"}` } } : p)),
  };
}

// Qwen 사고 모드의 <think> 블록은 기록에는 남기되 판정에서는 뺀다.
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
