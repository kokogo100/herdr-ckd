// A(Maker) ⇄ C(Relay) ⇄ B(Checker) 반복. A와 B는 직접 연결되지 않는다.
// 완료 = A DONE + B DONE + C PASS. C가 FAIL이면 A부터 다시.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { modelFor, type CkdConfig } from "./config.js";
import { stripThinking } from "./llm.js";
import { Recorder } from "./recorder.js";
import { RoleSession } from "./session.js";
import * as P from "./prompts.js";
import { startSerena, type ExternalTools } from "./serena.js";
import { prepareAttachments } from "./attachments.js";
import { curationFile, rebuildCurated } from "./curation.js";
import { factsText, inspectJob, trace2trainInspect } from "./inspect.js";
import type { ContentPart } from "./llm.js";

// limit_reached: 사용자가 정한 회차 한도에 닿아 멈춤 (오류로 끝난 failed와 구분)
// awaiting_review: A·B·C가 모두 완료라고 했고, 연결된 AI(MCP를 부른 쪽)의 확인(ckd_review)을 기다림
export type JobStatus = "running" | "awaiting_review" | "completed" | "stopped" | "failed" | "limit_reached";

export interface ReviewDecision {
  decision: "accept" | "rework";
  note: string;
}

export interface JobState {
  jobId: string;
  status: JobStatus;
  request: string;
  workspace: string;
  round: number;
  phase: string;
  doneCriteria: string[];
  definitions: string[];
  attachments: string[]; // 사용자가 첨부한 파일 (이미지, 문서)
  attachmentNotes: string[]; // 파일마다 준비 결과 (그림으로 붙임, 글자로 바꿈 등)
  maxRounds: number; // 이 작업의 회차 한도 (0이면 제한 없음)
  reviews: (ReviewDecision & { round: number; at: string })[]; // 연결된 AI(최종 확인자)의 판정 기록
  parentJobId?: string; // 이어서 다시 맡긴 경우 원래 작업 ID
  lastA?: { status?: string; summary?: string };
  lastB?: { status?: string; summary?: string };
  lastJudge?: { verdict: string; reason: string };
  report?: string;
  error?: string;
  warnings: string[];
  startedAt: string;
  finishedAt?: string;
}

// C는 JSON으로 답한다. 코드 블록이나 앞뒤 설명이 붙어도 첫 JSON 객체를 꺼낸다.
export function extractJson(text: string): Record<string, unknown> | undefined {
  const cleaned = stripThinking(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// JSON 문자열 안의 Windows 절대 경로(F:\a\b)와 POSIX 절대 경로(/a/b)를 뽑는다.
function extractPaths(jsonText: string): string[] {
  const text = jsonText.replace(/\\\\/g, "\\");
  const found = text.match(/[A-Za-z]:\\[^\s"'`,()<>|]+|(?<![\w.:/])\/(?:[\w.-]+\/)+[\w.-]*/g) ?? [];
  return [...new Set(found.map((p) => p.replace(/[.\\/]+$/, "")))];
}

// 대조 단계가 처음 지시에 없던, 실제로 없는 경로를 만들어 냈는지 본다.
export function inventedPaths(draftJson: string, reviewedJson: string): string[] {
  const before = new Set(extractPaths(draftJson));
  return extractPaths(reviewedJson).filter((p) => !before.has(p) && !fs.existsSync(p));
}

const SNAPSHOT_SKIP = new Set([".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", "dist"]);
const SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;

// 작업 폴더가 비어 있지 않으면 사본을 만든다. 크면(20MB 초과) 만들지 않는다.
export function snapshotWorkspace(workspace: string, dest: string): string | undefined {
  if (!fs.existsSync(workspace)) return undefined;
  const files: string[] = [];
  let bytes = 0;
  const walk = (dir: string): boolean => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SNAPSHOT_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!walk(full)) return false;
      } else if (e.isFile()) {
        bytes += fs.statSync(full).size;
        if (bytes > SNAPSHOT_MAX_BYTES) return false;
        files.push(full);
      }
    }
    return true;
  };
  if (!walk(workspace) || files.length === 0) return undefined;
  for (const f of files) {
    const target = path.join(dest, path.relative(workspace, f));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f, target);
  }
  return dest;
}

// 대조 결과에만 붙는 requirements는 빼고 실제 지시 내용이 바뀌었는지 본다.
function briefChanged(draft: Record<string, unknown>, brief: Record<string, unknown>): boolean {
  const pick = (b: Record<string, unknown>) => JSON.stringify([b.instruction_for_A, b.done_criteria, b.definitions ?? []]);
  return pick(draft) !== pick(brief);
}

// 기록에는 API 키를 남기지 않는다.
function redact(config: CkdConfig): unknown {
  return JSON.parse(JSON.stringify(config, (k, v) => (k === "apiKey" ? "***" : v)));
}

// C(Relay)도 독립 세션이다. 외부 검색 도구를 쓸 수 있고, 판단은 JSON으로 답한다.
class RelaySession {
  readonly session: RoleSession;

  constructor(config: CkdConfig, recorder: Recorder, workspace: string) {
    this.session = new RoleSession("C", modelFor(config, "C"), P.systemPromptC(config), config, recorder, workspace, []);
  }

  // verify가 true면 판정처럼 직접 확인이 필요한 질문이다. 도구를 한 번도 쓰지 않고 답하면 한 번 되돌려 보낸다.
  async ask(content: string, signal?: AbortSignal, verify = false, images: ContentPart[] = []): Promise<Record<string, unknown>> {
    let reply = await this.session.send(content, signal, images);
    if (verify && (reply.toolCalls ?? 0) === 0) {
      this.session.recorder.event("judge_unverified", { session: this.session.sessionId });
      reply = await this.session.send(P.VERIFY_FIRST, signal);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const json = extractJson(reply.text);
      if (json) return json;
      this.session.recorder.event("format_error", { session: this.session.sessionId });
      reply = await this.session.send("JSON 형식으로만 다시 답하세요.", signal);
    }
    const json = extractJson(reply.text);
    if (json) return json;
    throw new Error("C가 JSON 형식으로 답하지 못했습니다.");
  }

  exportFinetune(meta: Record<string, unknown>): void {
    this.session.exportFinetune(meta);
  }
}

export class Job {
  readonly state: JobState;
  readonly recorder: Recorder;
  private abort = new AbortController();
  private reviewWaiter?: (r: ReviewDecision) => void;
  private pauseWaiters: ((s: JobState) => void)[] = [];
  done: Promise<JobState>;

  constructor(
    private config: CkdConfig,
    request: string,
    workspace: string,
    readPaths: string[] = [],
    attachments: string[] = [],
    maxRounds?: number, // 이 작업에만 적용할 회차 한도. 주지 않으면 설정의 maxRounds(기본 0 = 제한 없음)
    parentJobId?: string,
  ) {
    // 첨부 파일은 A·B·C가 읽을 수 있게 읽기 전용 경로에 더한다. 없는 파일은 경고로 남긴다.
    const attached = attachments.map((p) => path.resolve(p));
    const missing = attached.filter((p) => !fs.existsSync(p) || !fs.statSync(p).isFile());
    const present = attached.filter((p) => !missing.includes(p));
    // 작업마다 읽기 전용 경로를 더할 수 있다
    this.config = { ...config, readPaths: [...config.readPaths, ...readPaths, ...present].map((p) => path.resolve(p)) };
    const jobId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
    this.recorder = new Recorder(config.dataDir, jobId);
    // 버그 수정 전후를 비교할 수 있도록 작업 시작 때의 작업 폴더를 사본으로 남긴다.
    const original = snapshotWorkspace(path.resolve(workspace), path.join(this.recorder.jobDir, "original"));
    if (original) this.config = { ...this.config, readPaths: [...this.config.readPaths, original], originalCopy: original };
    if (maxRounds !== undefined) this.config = { ...this.config, maxRounds: Math.max(0, Math.floor(maxRounds)) };
    // 첨부 문서를 글자로 바꾼 파일과 PDF 페이지 그림이 놓일 곳
    if (present.length > 0) this.config = { ...this.config, readPaths: [...this.config.readPaths, path.join(this.recorder.jobDir, "attachments")] };
    this.state = {
      jobId,
      status: "running",
      request,
      workspace: path.resolve(workspace),
      round: 0,
      phase: "시작",
      doneCriteria: [],
      definitions: [],
      attachments: present,
      attachmentNotes: [],
      maxRounds: this.config.maxRounds,
      reviews: [],
      ...(parentJobId ? { parentJobId } : {}),
      warnings: missing.map((p) => `첨부 파일이 없어 빼고 진행합니다: ${p}`),
      startedAt: new Date().toISOString(),
    };
    this.done = this.run();
  }

  // 작업이 멈추면(연결된 AI 확인 대기 또는 끝) 돌려준다. ckd_run의 wait에 쓴다.
  paused(): Promise<JobState> {
    if (this.state.status !== "running") return Promise.resolve(this.state);
    return new Promise((resolve) => this.pauseWaiters.push(resolve));
  }

  private notifyPaused(): void {
    for (const w of this.pauseWaiters.splice(0)) w(this.state);
  }

  // 연결된 AI의 확인. 확인 대기 중일 때만 받는다. 문제가 있으면 안내 문구를, 받았으면 undefined를 돌려준다.
  review(decision: ReviewDecision["decision"], note = ""): string | undefined {
    if (this.state.status !== "awaiting_review" || !this.reviewWaiter) {
      return `이 작업은 연결된 AI의 확인을 기다리는 상태가 아닙니다 (지금 상태: ${this.state.status}). 끝난 작업을 다시 하려면 ckd_run에 parent_job_id로 이 작업 ID를 넣어 새로 맡기세요.`;
    }
    if (decision === "rework" && !note.trim()) return "rework에는 무엇이 아직 안 됐는지 note가 필요합니다.";
    const resolve = this.reviewWaiter;
    this.reviewWaiter = undefined;
    // 다시 하기면 바로 진행 중으로 바꿔, 부른 쪽이 곧바로 상태를 봐도 이전 대기 상태가 보이지 않게 한다.
    if (decision === "rework") this.state.status = "running";
    resolve({ decision, note });
    return undefined;
  }

  private waitForReview(signal: AbortSignal): Promise<ReviewDecision> {
    return new Promise((resolve, reject) => {
      this.reviewWaiter = resolve;
      signal.addEventListener("abort", () => reject(new Error("사용자가 중지했습니다.")), { once: true });
    });
  }

  stop(): void {
    this.abort.abort();
  }

  private save(phase?: string): void {
    if (phase) this.state.phase = phase;
    this.recorder.saveState(this.state);
  }

  private async run(): Promise<JobState> {
    const { config, recorder, state } = this;
    const signal = this.abort.signal;
    let external: ExternalTools | undefined;
    if (config.tools.serena && fs.existsSync(state.workspace)) {
      try {
        external = await startSerena(config, state.workspace);
        recorder.event("serena_started", { tools_A: external.specs("A").length, tools_B: external.specs("B").length });
      } catch (err) {
        // Serena가 없어도 기본 도구로 계속 진행한다.
        state.warnings.push(`Serena를 시작하지 못해 기본 도구로 진행합니다: ${(err as Error).message}`);
        recorder.event("serena_unavailable", { error: (err as Error).message });
      }
    }
    const C = new RelaySession(config, recorder, state.workspace);
    const A = new RoleSession("A", modelFor(config, "A"), P.systemPromptA(config), config, recorder, state.workspace, ["DONE", "WORKING", "QUESTION"], external);
    const B = new RoleSession("B", modelFor(config, "B"), P.systemPromptB(config), config, recorder, state.workspace, ["DONE", "NEEDS_FIX", "QUESTION"], external);

    try {
      if (!fs.existsSync(state.workspace)) throw new Error(`작업 폴더가 없습니다: ${state.workspace}`);
      recorder.event("job_start", { request: state.request, workspace: state.workspace, attachments: state.attachments, max_rounds: state.maxRounds, parent_job_id: state.parentJobId, config: redact(config) });
      // 첨부 이미지는 C의 첫 질문과 A·B의 첫 메시지에 그림으로 붙인다.
      // 이미지를 못 읽는 모델(vision: false)에게는 그림을 붙이지 않는다.
      const prepared = await prepareAttachments(state.attachments, path.join(recorder.jobDir, "attachments"), {
        vision: (["A", "B", "C"] as const).some((r) => modelFor(config, r).vision !== false),
        maxImages: config.attachments.maxImages,
        maxImageBytes: config.attachments.maxImageMB * 1024 * 1024,
        pdfPages: config.attachments.pdfPages,
      });
      state.attachmentNotes = prepared.notes;
      state.warnings.push(...prepared.warnings);
      if (state.attachments.length > 0) recorder.event("attachments", { notes: prepared.notes, images: prepared.images.length, warnings: prepared.warnings });
      const imagesFor = (r: "A" | "B" | "C"): ContentPart[] => (modelFor(config, r).vision === false ? [] : prepared.images);

      this.save("C가 작업 지시 작성 중");
      const draft = await C.ask(P.briefRequestForC(state.request, state.workspace, state.attachmentNotes), signal, false, imagesFor("C"));
      this.save("C가 작업 지시를 사용자 요청과 대조 중");
      const reviewed = await C.ask(P.reviewBriefForC(state.request, JSON.stringify(draft, null, 2)), signal);
      // 대조 단계가 실제로 없는 새 경로를 만들어 냈으면(오타 등) 대조 결과를 버리고 처음 지시를 쓴다.
      const invented = inventedPaths(JSON.stringify(draft), JSON.stringify(reviewed));
      const usable = typeof reviewed.instruction_for_A === "string" && Array.isArray(reviewed.done_criteria) && invented.length === 0;
      const brief = usable ? reviewed : draft;
      recorder.event("brief_review", { requirements: reviewed.requirements, changed: briefChanged(draft, brief), invented_paths: invented });
      const instruction = String(brief.instruction_for_A ?? state.request);
      state.doneCriteria = Array.isArray(brief.done_criteria) ? brief.done_criteria.map(String) : [];
      state.definitions = Array.isArray(brief.definitions)
        ? brief.definitions.map((d) => {
            if (d && typeof d === "object") {
              const o = d as Record<string, unknown>;
              return `${o.item ?? ""}: ${o.source ?? ""}, ${o.formula ?? ""}`;
            }
            return String(d);
          })
        : [];
      recorder.event("brief", { instruction, done_criteria: state.doneCriteria, definitions: state.definitions });

      let messageForA = `C(전달자)가 전하는 작업 지시입니다.\n\n${instruction}\n\n완료 조건:\n${state.doneCriteria.map((c) => `* ${c}`).join("\n")}${P.formatDefinitions(state.definitions)}`;
      const contextForB = P.taskContextForB(state.request, state.doneCriteria, state.definitions, state.attachmentNotes);
      let questionStreak = 0;
      let fixStreak = 0; // B가 NEEDS_FIX를 연속으로 낸 회차 수
      let noteForB = "";
      let lastAText = "";
      let lastBText = "";

      while (true) {
        // 회차 한도에 닿으면 오류로 끝내지 않고, C가 지금까지의 결과를 정리해 보고한다.
        if (config.maxRounds > 0 && state.round >= config.maxRounds) {
          state.status = "limit_reached";
          recorder.event("limit_reached", { rounds: state.round, max_rounds: config.maxRounds });
          this.save(`${config.maxRounds}회 한도 도달: C(Relay)가 보고 작성 중`);
          const limitReport = await C.ask(P.limitReportForC(state.request, state.doneCriteria, config.maxRounds, lastAText, lastBText), signal);
          state.report = String(limitReport.report_for_user ?? limitReport.summary ?? "");
          state.error = `${config.maxRounds}회 한도에 도달했습니다.`;
          break;
        }
        state.round++;

        this.save(`${state.round}회차: A(Maker) 작업 중`);
        const a = await A.send(state.round === 1 ? messageForA + P.attachmentsNote(state.attachmentNotes) : messageForA, signal, state.round === 1 ? imagesFor("A") : []);
        state.lastA = { status: a.status?.status, summary: a.status?.summary };
        lastAText = a.text;
        recorder.event("relay", { round: state.round, from: "A", to: "C", status: a.status });

        const bothAsking = a.status?.status === "QUESTION";
        let messageForB = (state.round === 1 ? contextForB : "") + noteForB + P.relayFromA(a.text, a.status?.status ?? "형식 오류");
        noteForB = "";
        if (questionStreak >= config.pingPongLimit) messageForB += `\n\n${P.PINGPONG_WRAP_UP}`;

        this.save(`${state.round}회차: B(Checker) 검수 중`);
        const b = await B.send(messageForB, signal, state.round === 1 ? imagesFor("B") : []);
        state.lastB = { status: b.status?.status, summary: b.status?.summary };
        lastBText = b.text;
        recorder.event("relay", { round: state.round, from: "B", to: "C", status: b.status });

        // 핑퐁: A와 B가 둘 다 질문만 주고받는 회차가 이어지면 C가 정리를 지시한다.
        questionStreak = bothAsking && b.status?.status === "QUESTION" ? questionStreak + 1 : 0;

        if (a.status?.status === "DONE" && b.status?.status === "DONE") {
          this.save(`${state.round}회차: C(Relay) 최종 판단 중`);
          const failed = [...(a.failedCommands ?? []).map((f) => `A: ${f}`), ...(b.failedCommands ?? []).map((f) => `B: ${f}`)];
          const verdict = await C.ask(P.judgeRequestForC(state.request, state.doneCriteria, state.definitions, a.text, b.text, state.round, failed), signal, true);
          // 완료 조건 중 하나라도 충족되지 않았다고 C가 적었으면 PASS라고 답해도 FAIL로 본다.
          const unmet = Array.isArray(verdict.criteria_check)
            ? verdict.criteria_check.filter((c) => c && typeof c === "object" && (c as Record<string, unknown>).met === false)
            : [];
          const pass = String(verdict.verdict).toUpperCase() === "PASS" && unmet.length === 0;
          if (unmet.length > 0 && String(verdict.verdict).toUpperCase() === "PASS") {
            verdict.reason = `충족되지 않은 완료 조건이 있습니다: ${unmet.map((c) => String((c as Record<string, unknown>).criterion)).join(", ")}. ${verdict.reason ?? ""}`;
            verdict.instruction_for_A ??= "충족되지 않은 완료 조건을 처리하세요.";
          }
          state.lastJudge = { verdict: pass ? "PASS" : "FAIL", reason: String(verdict.reason ?? "") };
          recorder.event("judge", { round: state.round, ...verdict });

          if (pass) {
            state.report = String(verdict.report_for_user ?? verdict.reason ?? "완료했습니다.");
            if (!config.requireReview) {
              state.status = "completed";
              break;
            }
            // A·B·C가 모두 완료라고 했다. 연결된 AI(4번째)가 직접 확인할 때까지 기다린다.
            state.status = "awaiting_review";
            recorder.event("awaiting_review", { round: state.round });
            this.save("A·B·C 완료, 연결된 AI의 확인 대기");
            this.notifyPaused();
            const r = await this.waitForReview(signal);
            state.reviews.push({ ...r, round: state.round, at: new Date().toISOString() });
            recorder.event("review", { round: state.round, decision: r.decision, note: r.note });
            if (r.decision === "accept") {
              state.status = "completed";
              break;
            }
            // 다시 하기: 같은 A·B·C 세션으로 다음 회차를 이어 간다. 지적은 완료 조건에도 더해 C의 판정에 들어가게 한다.
            state.status = "running";
            state.report = undefined;
            state.doneCriteria.push(`연결된 AI(최종 확인자)의 지적이 해결됨: ${r.note}`);
            messageForA = P.relayFromReviewer(r.note);
            noteForB = P.reviewerNoteForB(r.note);
            fixStreak = 0;
            this.save(`${state.round}회차 뒤 연결된 AI가 다시 하기를 요청`);
            continue;
          }
          messageForA = P.relayFailFromC(state.lastJudge.reason, String(verdict.instruction_for_A ?? ""), b.text);
        } else {
          messageForA = P.relayFromB(b.text, b.status?.status ?? "형식 오류");
          fixStreak = b.status?.status === "NEEDS_FIX" ? fixStreak + 1 : 0;
          // 같은 지적이 이어지면 C가 끼어들어 원인이 코드인지 검사 방법(도구 한계 포함)인지 직접 확인한다.
          if (fixStreak >= config.fixStreakLimit) {
            this.save(`${state.round}회차: C(Relay)가 반복되는 수정 요청을 진단 중`);
            const diag = await C.ask(P.diagnoseRepeatedFixForC(state.request, fixStreak, a.text, b.text), signal, true);
            recorder.event("fix_streak_diagnosis", { round: state.round, streak: fixStreak, ...diag });
            messageForA += `\n\n${P.relayDiagnosisFromC(String(diag.diagnosis ?? ""), String(diag.instruction_for_A ?? ""))}`;
            noteForB = P.relayDiagnosisFromC(String(diag.diagnosis ?? ""), String(diag.note_for_B ?? "")) + "\n\n";
            fixStreak = 0;
          }
        }
        if (questionStreak >= config.pingPongLimit) {
          recorder.event("pingpong_wrap_up", { round: state.round });
          messageForA += `\n\n${P.PINGPONG_WRAP_UP}`;
        }
      }
    } catch (err) {
      state.status = signal.aborted ? "stopped" : "failed";
      state.error = signal.aborted ? "사용자가 중지했습니다." : (err as Error).message;
      recorder.event("job_error", { error: state.error });
    }

    await external?.close().catch(() => undefined);
    state.finishedAt = new Date().toISOString();
    this.notifyPaused();
    // C가 기록을 정리해 학습·평가용 표시(좋은 예/나쁜 예)를 남긴다. 사용자가 멈춘 작업은 건너뛴다.
    let label: string | undefined;
    if (config.curateLogs && !signal.aborted) {
      try {
        this.save("C(Relay)가 작업 기록 정리 중");
        // C가 판단하기 전에 기계가 센 사실을 먼저 준다.
        this.save();
        const facts = inspectJob(recorder.jobDir);
        const t2t = trace2trainInspect(recorder.jobDir);
        const curation = await C.ask(P.curateLogForC(state.status, state.round, state.error, factsText(facts)), undefined);
        label = typeof curation.suggested_label === "string" ? curation.suggested_label : undefined;
        // 학습 표시는 C의 제안(suggested_label)일 뿐이고, 사람 판정(human_verdict)이 붙어야 확정된다.
        const record = {
          job_id: state.jobId,
          request: state.request,
          outcome: state.status,
          rounds: state.round,
          max_rounds: state.maxRounds,
          reviewer_decisions: state.reviews,
          ...curation,
          facts,
          ...(t2t ? { trace2train: t2t } : {}),
          human_verdict: null,
          training_label: null,
        };
        fs.writeFileSync(path.join(recorder.jobDir, "curation.json"), JSON.stringify(record, null, 2));
        rebuildCurated(config.dataDir);
        recorder.event("curation", { suggested_label: label, result_quality: curation.result_quality });
      } catch (err) {
        recorder.event("curation_error", { error: (err as Error).message });
      }
    }
    if (config.curateLogs) {
      const meta = { outcome: state.status, rounds: state.round, max_rounds: state.maxRounds, ...(label ? { suggested_label: label } : {}) };
      A.exportFinetune(meta);
      B.exportFinetune(meta);
      C.exportFinetune(meta);
      fs.appendFileSync(
        path.join(config.dataDir, "finetune", "jobs.jsonl"),
        JSON.stringify({ job_id: state.jobId, outcome: state.status, rounds: state.round, max_rounds: state.maxRounds, request: state.request, attachments: state.attachments, suggested_label: label, finished_at: state.finishedAt }) + "\n",
      );
    }
    recorder.event("job_end", { status: state.status, rounds: state.round });
    this.save(state.status === "completed" ? "완료" : state.status);
    return state;
  }
}

// 사람 판정이 붙은 작업을 C가 다시 정리한다. 처음 정리는 draft로 남기고, 다시 쓴 내용으로 바꾼다.
export async function refineCuration(config: CkdConfig, jobId: string): Promise<Record<string, unknown>> {
  const jobDir = path.join(config.dataDir, "jobs", jobId);
  const file = curationFile(config.dataDir, jobId);
  if (!fs.existsSync(file)) throw new Error(`정리 기록이 없습니다: ${jobId}`);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
  const verdict = record.human_verdict as { verdict: string; note?: string } | null;
  if (!verdict) throw new Error(`사람 판정이 아직 없습니다: ${jobId}`);
  const state = JSON.parse(fs.readFileSync(path.join(jobDir, "state.json"), "utf8"));
  const facts = inspectJob(jobDir);
  const { facts: _f, draft: _d, trace2train: _t, revisions: _r, feedback_history: _h, ...previous } = record;
  // 정리용 C 세션은 원래 기록과 섞이지 않게 jobs/_curation/<ID> 아래에 남긴다.
  const recorder = new Recorder(config.dataDir, path.join("_curation", jobId));
  const C = new RelaySession(config, recorder, state.workspace);
  const refined = await C.ask(P.refineCurationForC(JSON.stringify(previous, null, 2), verdict.verdict, (Array.isArray(record.feedback_history) ? record.feedback_history : [verdict]).map((h: { note?: string }) => h.note ?? "").filter(Boolean), factsText(facts)), undefined);
  const revision = Number(record.revision ?? 0) + 1;
  const updated = {
    ...record,
    draft: record.draft ?? { summary: record.summary, mistakes: record.mistakes, lessons: record.lessons, evidence: record.evidence, result_quality: record.result_quality },
    ...refined,
    facts,
    // 사람 판정과 학습 표시는 C가 바꿀 수 없다.
    human_verdict: record.human_verdict,
    training_label: record.training_label,
    suggested_label: record.suggested_label,
    revision,
    revisions: [...(Array.isArray(record.revisions) ? record.revisions : []), { revision, at: new Date().toISOString(), verdict: verdict.verdict, corrections: refined.corrections ?? [] }],
    refined_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(updated, null, 2));
  rebuildCurated(config.dataDir);
  return updated;
}

export class JobManager {
  private jobs = new Map<string, Job>();

  constructor(private config: CkdConfig) {}

  start(request: string, workspace?: string, readPaths: string[] = [], attachments: string[] = [], maxRounds?: number, parentJobId?: string): Job {
    const ws = workspace ?? this.config.defaultWorkspace;
    if (!ws) throw new Error("작업 폴더(workspace)를 지정해 주세요.");
    const job = new Job(this.config, request, ws, readPaths, attachments, maxRounds, parentJobId);
    this.jobs.set(job.state.jobId, job);
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  // 서버가 재시작된 뒤에도 기록된 상태는 조회할 수 있다.
  readState(jobId: string): JobState | undefined {
    const live = this.jobs.get(jobId);
    if (live) return live.state;
    const file = path.join(this.config.dataDir, "jobs", jobId, "state.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
  }
}
