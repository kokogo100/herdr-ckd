// 역할 하나의 독립 세션. A·B·C는 각자 이 세션을 따로 가진다.
import type { CkdConfig, ModelConfig, Role } from "./config.js";
import { chatWithRetry, stripThinking, textOf, type ChatMessage, type ContentPart } from "./llm.js";
import type { Recorder } from "./recorder.js";
import { runTool, toolSpecs, type ToolProfile } from "./tools.js";
import { FORMAT_FIX, HANDOFF_REQUEST, REPEATED_CALL, TOOL_LIMIT_REACHED } from "./prompts.js";
import type { ExternalTools } from "./serena.js";

export interface SessionOptions {
  label?: string; // 예: "A", "B1", "C1", "B2", "C2"
  toolProfile?: ToolProfile; // "leader" | "checker" | "maker"
}

export interface StatusBlock {
  status: string;
  summary?: string;
}

export interface Reply {
  text: string; // 사고 블록과 상태 블록을 뺀 본문
  rawText: string;
  status?: StatusBlock;
  hitToolLimit?: boolean;
  toolCalls?: number; // 이번 답을 내는 동안 실행한 도구 호출 수
  failedCommands?: string[]; // 종료 코드가 0이 아닌 run_command (자동 수집)
}

function commandOf(rawArgs: string): string {
  try {
    return String(JSON.parse(rawArgs).command ?? rawArgs);
  } catch {
    return rawArgs;
  }
}

const STATUS_RE = /<CKD_STATUS>\s*([\s\S]*?)\s*<\/CKD_STATUS>\s*$/;

// 본문 맨 끝의 상태 블록만 인정한다. 인용된 블록은 무시.
export function parseStatus(text: string, allowed: string[]): StatusBlock | undefined {
  const m = text.match(STATUS_RE);
  if (!m) return undefined;
  try {
    const parsed = JSON.parse(m[1]);
    if (typeof parsed.status !== "string" || !allowed.includes(parsed.status)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export class RoleSession {
  messages: ChatMessage[] = [];
  generation = 0;
  lastPromptTokens = 0;
  readonly label: string;
  readonly toolProfile?: ToolProfile;

  constructor(
    readonly role: Role,
    readonly model: ModelConfig,
    readonly systemPrompt: string,
    readonly config: CkdConfig,
    readonly recorder: Recorder,
    readonly workspace: string,
    readonly allowedStatus: string[],
    readonly external?: ExternalTools,
    options?: SessionOptions,
  ) {
    this.label = options?.label ?? role;
    this.toolProfile = options?.toolProfile;
    this.reset();
  }

  get sessionId(): string {
    return `${this.label}-${this.generation}`;
  }

  private reset(handoff?: string): void {
    this.messages = [];
    this.lastPromptTokens = 0;
    this.push({ role: "system", content: this.systemPrompt });
    if (handoff) {
      this.push({ role: "user", content: `이전 세션(${this.label}-${this.generation - 1})의 인계 요약입니다.\n\n${handoff}` });
      this.push({ role: "assistant", content: "인계 내용을 확인했습니다. 이어서 진행하겠습니다." });
    }
  }

  private push(msg: ChatMessage): void {
    this.messages.push(msg);
    this.recorder.message(this.sessionId, msg, { role_name: this.label, base_role: this.role });
  }

  // 메시지를 보내고, 모델이 도구를 다 쓰고 최종 답을 낼 때까지 반복한다.
  // images가 있으면 글과 함께 이미지 조각을 붙여 보낸다 (첨부 이미지).
  async send(content: string, signal?: AbortSignal, images: ContentPart[] = []): Promise<Reply> {
    await this.maybeHandoff(signal);
    this.push({ role: "user", content: images.length ? [{ type: "text", text: content }, ...images] : content });
    let reply = await this.runUntilFinal(signal, true);

    if (this.allowedStatus.length > 0 && !reply.status) {
      this.recorder.event("format_error", { session: this.sessionId });
      this.push({ role: "user", content: FORMAT_FIX });
      // 도구 한도에 걸린 뒤의 형식 재요청에서는 도구를 다시 주지 않는다.
      const before = reply.toolCalls ?? 0;
      const failedBefore = reply.failedCommands ?? [];
      reply = await this.runUntilFinal(signal, !reply.hitToolLimit);
      reply.toolCalls = before + (reply.toolCalls ?? 0);
      reply.failedCommands = [...failedBefore, ...(reply.failedCommands ?? [])];
    }
    return reply;
  }

  // 도구 한도에 닿으면 작업 전체를 실패로 끝내지 않고, 도구 없이 지금까지의 결과로 답하게 한다.
  private async runUntilFinal(signal: AbortSignal | undefined, allowTools: boolean): Promise<Reply> {
    const tools = allowTools ? toolSpecs(this.role, this.config, this.external, this.toolProfile) : [];
    const repeats = new Map<string, number>();
    let toolCalls = 0;
    const failedCommands: string[] = [];
    for (let step = 0; ; step++) {
      const atLimit = step >= this.config.maxToolSteps;
      if (atLimit && tools.length > 0) {
        this.recorder.event("tool_limit", { session: this.sessionId, limit: this.config.maxToolSteps });
        this.push({ role: "user", content: TOOL_LIMIT_REACHED(this.config.maxToolSteps) });
      }
      const useTools = tools.length > 0 && !atLimit;
      const result = await chatWithRetry(this.model, this.messages, useTools ? tools : undefined, signal);
      if (result.usage?.prompt_tokens) this.lastPromptTokens = result.usage.prompt_tokens;
      const msg = result.message;

      if (msg.tool_calls?.length && useTools) {
        this.push({
          role: "assistant",
          content: msg.content ?? "",
          tool_calls: msg.tool_calls,
          ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
        });
        const images: ContentPart[] = [];
        for (const call of msg.tool_calls) {
          toolCalls++;
          this.recorder.event("tool_call", { session: this.sessionId, tool: call.function.name, args: call.function.arguments });
          // 같은 호출을 되풀이하는 폭주를 막는다.
          const key = `${call.function.name}\u0000${call.function.arguments}`;
          const count = (repeats.get(key) ?? 0) + 1;
          repeats.set(key, count);
          const output = count >= 3
            ? REPEATED_CALL
            : await runTool(this.role, call.function.name, call.function.arguments, {
                workspace: this.workspace,
                config: this.config,
                signal,
                external: this.external,
                onImage: (p) => images.push(p),
                jobDir: this.recorder.jobDir,
              }, this.toolProfile);
          if (call.function.name === "run_command" && !output.startsWith("종료 코드 0\n")) {
            failedCommands.push(`${commandOf(call.function.arguments)} → ${output.split("\n").slice(0, 3).join(" / ").slice(0, 300)}`);
          }
          this.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: output });
        }
        if (images.length > 0) {
          const names = images.map((p) => (p.type === "image_url" ? p.source : "")).join(", ");
          this.push({ role: "user", content: [{ type: "text", text: `[view_image 결과] ${names}` }, ...images] });
        }
        continue;
      }

      // 도구를 주지 않았는데 도구 호출을 낸 경우, 짝이 맞지 않는 호출은 버리고 본문만 남긴다.
      this.push({
        role: "assistant",
        content: msg.content ?? "",
        ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
      });
      const rawText = textOf(msg.content);
      const visible = stripThinking(rawText);
      const status = parseStatus(visible, this.allowedStatus);
      return { rawText, text: visible.replace(STATUS_RE, "").trim(), status, hitToolLimit: atLimit && tools.length > 0, toolCalls, failedCommands };
    }
  }

  private estimateTokens(): number {
    if (this.lastPromptTokens > 0) return this.lastPromptTokens;
    // 이미지는 한 장에 대략 1000토큰으로 본다.
    const chars = this.messages.reduce((n, m) => n + textOf(m.content).length + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length * 3000 : 0), 0);
    return Math.ceil(chars / 3);
  }

  // 컨텍스트가 handoffRatio(기본 60%)를 넘으면 인계 요약을 받아 새 세션으로 넘어간다.
  private async maybeHandoff(signal?: AbortSignal): Promise<void> {
    const limit = (this.model.contextTokens ?? 262144) * this.config.handoffRatio;
    if (this.estimateTokens() < limit) return;
    this.push({ role: "user", content: HANDOFF_REQUEST });
    const result = await chatWithRetry(this.model, this.messages, undefined, signal);
    const summary = stripThinking(textOf(result.message.content));
    this.push({ role: "assistant", content: textOf(result.message.content) });
    this.exportFinetune({ ended_by: "handoff" });
    this.recorder.event("handoff", { from: this.sessionId, to: `${this.role}-${this.generation + 1}` });
    this.generation++;
    this.reset(summary);
  }

  exportFinetune(meta: Record<string, unknown>): void {
    this.recorder.exportFinetune(this.role, this.sessionId, this.messages, {
      model: this.model.model,
      backend: this.model.backend,
      ...meta,
    });
  }
}
