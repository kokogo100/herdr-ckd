// Herdr CKD 다중 스레드 오케스트레이터
// 확정 아키텍처:
//   C (1개 고정) = 중심 코어 (설계 · 작업 분해 · 중개 · 병합 · 최종 판정)
//   [A1·B1], [A2·B2], [A3·B3]... = 스레드별 실행자(An) + 전담 검수자(Bn) 1:1 다중 세트
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { modelFor, type CkdConfig, type ThreadExecutionMode } from "./config.js";
import type { ContentPart } from "./llm.js";
import { prepareAttachments } from "./attachments.js";
import { Recorder } from "./recorder.js";
import { RoleSession } from "./session.js";
import { extractJson, snapshotWorkspace, type JobStatus, type ReviewDecision } from "./orchestrator.js";
import * as MP from "./multi-prompts.js";
import * as P from "./prompts.js";
import {
  applyUnitToMain,
  cleanupUnitWorkspace,
  createUnitWorkspace,
  getUnitDiff,
  pruneOldRemoteBranches,
  syncUnitToGithub,
  syncUnitWithMain,
  type UnitWorkspace,
} from "./git-worktree.js";
import { cleanupJobTemp, enforceLogRetention } from "./retention.js";
import { publishThreadEvent, spawnHerdrUnitPane } from "./herdr-bridge.js";
import { rebuildCurated } from "./curation.js";
import { factsText, inspectJob } from "./inspect.js";

export type UnitStatus = "pending" | "working" | "checking" | "done" | "failed" | "merged" | "selected";

export interface ThreadUnitLogEntry {
  time: string;
  actor: string; // "A1" | "B1" | "C"
  status?: string;
  summary: string;
}

export interface ThreadUnitState {
  unitId: string; // "unit-1"
  unitIndex: number; // 1
  makerLabel: string; // "A1"
  checkerLabel: string; // "B1"
  title: string;
  targetFiles: string[];
  instruction: string;
  doneCriteria: string[];
  status: UnitStatus;
  round: number;
  changedFiles: string[];
  diffPreview: string;
  branchName?: string;
  prUrl?: string;
  lastMaker?: { status?: string; summary?: string; text?: string };
  lastChecker?: { status?: string; summary?: string; text?: string };
  logs: ThreadUnitLogEntry[];
}

export interface MultiJobState {
  jobId: string;
  engine: "herdr-multi";
  status: JobStatus;
  mode: "split" | "compete";
  request: string;
  workspace: string;
  round: number; // 통합 회차
  phase: string;
  maxUnits: number;
  maxRounds: number;
  overallCriteria: string[];
  definitions: string[];
  units: ThreadUnitState[];
  winnerUnitId?: string;
  lastJudge?: { verdict: string; reason: string };
  report?: string;
  error?: string;
  warnings: string[];
  attachments: string[];
  attachmentNotes: string[];
  reviews: (ReviewDecision & { round: number; at: string })[];
  cleanupSummary?: {
    worktreesCleaned: number;
    deletedOldJobs: string[];
    freedBytes: number;
  };
  startedAt: string;
  finishedAt?: string;
}

class LeaderSessionC {
  readonly session: RoleSession;

  constructor(config: CkdConfig, recorder: Recorder, workspace: string) {
    this.session = new RoleSession(
      "C",
      modelFor(config, "C"),
      MP.systemPromptLeaderC(config),
      config,
      recorder,
      workspace,
      [],
      undefined,
      { label: "C", toolProfile: "leader" },
    );
  }

  async askJson(content: string, signal?: AbortSignal, verify = false, images: ContentPart[] = []): Promise<Record<string, unknown>> {
    let reply = await this.session.send(content, signal, images);
    if (verify && (reply.toolCalls ?? 0) === 0) {
      this.session.recorder.event("leader_unverified", { session: this.session.sessionId });
      reply = await this.session.send(P.VERIFY_FIRST, signal);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const json = extractJson(reply.text);
      if (json) return json;
      this.session.recorder.event("format_error", { session: this.session.sessionId });
      reply = await this.session.send("반드시 유효한 JSON 객체 형식으로만 다시 답하세요.", signal);
    }
    const json = extractJson(reply.text);
    if (json) return json;
    throw new Error("중심 코어 C가 JSON 형식으로 답하지 못했습니다.");
  }

  exportFinetune(meta: Record<string, unknown>): void {
    this.session.exportFinetune(meta);
  }
}

interface UnitRuntime {
  state: ThreadUnitState;
  ws: UnitWorkspace;
  maker: RoleSession; // A_n
  checker: RoleSession; // B_n
}

export interface StartMultiJobOptions {
  request: string;
  workspace: string;
  maxUnits?: number;
  mode?: ThreadExecutionMode;
  maxRounds?: number;
  parallelUnits?: boolean;
  readPaths?: string[];
  attachments?: string[];
}

export class MultiJob {
  readonly state: MultiJobState;
  readonly recorder: Recorder;
  private abort = new AbortController();
  private reviewWaiter?: (r: ReviewDecision) => void;
  private pauseWaiters: ((s: MultiJobState) => void)[] = [];
  done: Promise<MultiJobState>;

  constructor(
    private config: CkdConfig,
    opts: StartMultiJobOptions,
    private onFinishCleanup?: (jobId: string) => { deletedJobs: string[]; freedBytes: number },
  ) {
    const attached = (opts.attachments ?? []).map((p) => path.resolve(p));
    const missing = attached.filter((p) => !fs.existsSync(p) || !fs.statSync(p).isFile());
    const present = attached.filter((p) => !missing.includes(p));

    const maxUnits = Math.max(1, Math.min(8, opts.maxUnits ?? config.threads.maxUnits));
    let parsedMaxRounds = opts.maxRounds !== undefined ? Math.max(0, Math.floor(opts.maxRounds)) : config.maxRounds;
    if (opts.maxRounds === undefined && parsedMaxRounds === 0) {
      const mRound = opts.request.match(/(?:최대\s*|max(?:imum)?\s*)?(\d{1,2})\s*(?:회차?(?:\s*안으로|\s*이내|\s*까지만|\s*제한|\s*만)?|번만|rounds?\s*(?:max|limit|only)?)/i);
      if (mRound && /(?:최대|안으로|이내|까지만|제한|번만|max|limit|within|only)/i.test(mRound[0])) {
        parsedMaxRounds = Math.max(1, Number(mRound[1]));
      }
    }
    const maxRounds = parsedMaxRounds;
    const parallelUnits = opts.parallelUnits !== undefined ? Boolean(opts.parallelUnits) : (config.threads.parallelUnits ?? true);

    this.config = {
      ...config,
      maxRounds,
      threads: {
        ...config.threads,
        maxUnits,
        defaultMode: opts.mode ?? config.threads.defaultMode,
        parallelUnits,
      },
      readPaths: [...config.readPaths, ...(opts.readPaths ?? []), ...present].map((p) => path.resolve(p)),
    };

    const jobId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
    this.recorder = new Recorder(this.config.dataDir, jobId);

    const resolvedWs = path.resolve(opts.workspace);
    const original = snapshotWorkspace(resolvedWs, path.join(this.recorder.jobDir, "original"));
    if (original) {
      this.config = { ...this.config, readPaths: [...this.config.readPaths, original], originalCopy: original };
    }
    if (present.length > 0) {
      this.config = { ...this.config, readPaths: [...this.config.readPaths, path.join(this.recorder.jobDir, "attachments")] };
    }

    this.state = {
      jobId,
      engine: "herdr-multi",
      status: "running",
      mode: "split",
      request: opts.request,
      workspace: resolvedWs,
      round: 0,
      phase: "중심 코어 C 시작",
      maxUnits,
      maxRounds,
      overallCriteria: [],
      definitions: [],
      units: [],
      warnings: missing.map((p) => `첨부 파일이 없어 제외합니다: ${p}`),
      attachments: present,
      attachmentNotes: [],
      reviews: [],
      startedAt: new Date().toISOString(),
    };

    this.done = this.run();
  }

  paused(): Promise<MultiJobState> {
    if (this.state.status !== "running") return Promise.resolve(this.state);
    return new Promise((resolve) => this.pauseWaiters.push(resolve));
  }

  private notifyPaused(): void {
    for (const w of this.pauseWaiters.splice(0)) w(this.state);
  }

  stop(): void {
    this.abort.abort();
  }

  review(decision: ReviewDecision["decision"], note = ""): string | undefined {
    if (this.state.status !== "awaiting_review" || !this.reviewWaiter) {
      return `확인 대기 상태가 아닙니다 (현재 상태: ${this.state.status}).`;
    }
    if (decision === "rework" && !note.trim()) return "rework 시 수정 요청 내용(note)이 필요합니다.";
    const resolve = this.reviewWaiter;
    this.reviewWaiter = undefined;
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

  private save(phase?: string): void {
    if (phase) this.state.phase = phase;
    this.recorder.saveState(this.state);
  }

  private pushUnitLog(unit: ThreadUnitState, actor: string, status: string | undefined, summary: string): void {
    unit.logs.push({
      time: new Date().toISOString(),
      actor,
      status,
      summary: summary.slice(0, 300),
    });
    if (unit.logs.length > 30) unit.logs.shift();
  }

  private async runUnitLoop(
    rt: UnitRuntime,
    signal: AbortSignal,
    imagesMaker: ContentPart[],
    imagesChecker: ContentPart[],
    extraInstruction?: string,
  ): Promise<void> {
    const { state: u, ws, maker, checker } = rt;
    const contextChecker = P.taskContextForB(
      `${this.state.request}\n\n[이 스레드(${u.unitId}: ${u.title}) 담당 범위]\n${u.instruction}`,
      u.doneCriteria,
      this.state.definitions,
      this.state.attachmentNotes,
    );

    let msgForMaker = extraInstruction
      ? `중심 코어 C의 재작업 지시입니다:\n\n${extraInstruction}\n\n완료 조건:\n${u.doneCriteria.map((c) => `* ${c}`).join("\n")}`
      : `중심 코어 C가 배정한 ${u.makerLabel} 스레드 작업 지시입니다.\n제목: ${u.title}\n담당 파일: ${u.targetFiles.join(", ") || "(자율)"}\n\n${u.instruction}\n\n완료 조건:\n${u.doneCriteria.map((c) => `* ${c}`).join("\n")}${P.formatDefinitions(this.state.definitions)}${P.attachmentsNote(this.state.attachmentNotes)}`;
    let fixStreak = 0;

    // 1회(통합 사이클) 안에서 A_n과 B_n은 둘 다 DONE을 선언할 때까지 제한 없이 핑퐁을 반복한다.
    for (let localRound = 1; !signal.aborted; localRound++) {
      u.round++;
      u.status = "working";
      this.pushUnitLog(u, u.makerLabel, "WORKING", `${u.round}회차 구현 시작`);
      this.save();
      publishThreadEvent(this.config, {
        jobId: this.state.jobId,
        unitId: u.unitId,
        actor: u.makerLabel,
        state: "working",
        phase: `${u.makerLabel} 구현 중 (${u.round}회차): ${u.title}`,
        round: u.round,
      });

      const aReply = await maker.send(msgForMaker, signal, u.round === 1 ? imagesMaker : []);
      const diff = getUnitDiff(ws);
      u.changedFiles = diff.changedFiles;
      u.diffPreview = diff.diffText.slice(0, 8000);
      u.lastMaker = { status: aReply.status?.status, summary: aReply.status?.summary, text: aReply.text };
      this.pushUnitLog(u, u.makerLabel, aReply.status?.status, aReply.status?.summary ?? aReply.text.slice(0, 140));
      this.recorder.event("unit_maker", { unit: u.unitId, actor: u.makerLabel, round: u.round, status: aReply.status, changed_files: diff.changedFiles });

      // 선택형 GitHub PR 검수 모드일 때 B 검수 전 브랜치/PR 동기화
      if (this.config.github.mode === "pr_on_review") {
        const gh = syncUnitToGithub(ws, this.config, `${u.makerLabel} round ${u.round}: ${u.title}`);
        if (gh.prUrl) u.prUrl = gh.prUrl;
        if (gh.warning) this.state.warnings.push(gh.warning);
      }

      u.status = "checking";
      this.pushUnitLog(u, u.checkerLabel, "CHECKING", `${u.round}회차 전담 검수 시작`);
      this.save();
      publishThreadEvent(this.config, {
        jobId: this.state.jobId,
        unitId: u.unitId,
        actor: u.checkerLabel,
        state: "working",
        phase: `${u.checkerLabel} 검수 중 (${u.round}회차): ${u.title}`,
        round: u.round,
        diffFiles: u.changedFiles,
        prUrl: u.prUrl,
      });

      const msgForChecker = (u.round === 1 ? contextChecker : "") +
        MP.relayMakerToChecker(u.unitIndex, aReply.text, aReply.status?.status ?? "WORKING", diff.diffText);
      const bReply = await checker.send(msgForChecker, signal, u.round === 1 ? imagesChecker : []);
      u.lastChecker = { status: bReply.status?.status, summary: bReply.status?.summary, text: bReply.text };
      this.pushUnitLog(u, u.checkerLabel, bReply.status?.status, bReply.status?.summary ?? bReply.text.slice(0, 140));
      this.recorder.event("unit_checker", { unit: u.unitId, actor: u.checkerLabel, round: u.round, status: bReply.status });

      if (aReply.status?.status === "DONE" && bReply.status?.status === "DONE") {
        u.status = "done";
        if (this.config.github.mode === "push_on_complete") {
          const gh = syncUnitToGithub(ws, this.config, `${u.unitId} passed: ${u.title}`);
          if (gh.warning) this.state.warnings.push(gh.warning);
        }
        this.save();
        publishThreadEvent(this.config, {
          jobId: this.state.jobId,
          unitId: u.unitId,
          actor: u.checkerLabel,
          state: "done",
          phase: `${u.unitId} (${u.makerLabel}·${u.checkerLabel}) 통과 완료`,
          round: u.round,
          diffFiles: u.changedFiles,
        });
        return;
      }

      if (bReply.status?.status === "NEEDS_FIX") {
        fixStreak++;
      } else {
        fixStreak = 0;
      }

      const hasQuestion = aReply.status?.status === "QUESTION" || bReply.status?.status === "QUESTION";
      const streakHit = this.config.fixStreakLimit > 0 && fixStreak >= this.config.fixStreakLimit;
      let guidancePrefix = "";
      if (streakHit || hasQuestion) {
        this.recorder.event("unit_leader_guidance", {
          unit: u.unitId,
          round: u.round,
          fix_streak: fixStreak,
          has_question: hasQuestion,
        });
        guidancePrefix = MP.leaderGuidanceForMaker(u.unitIndex, fixStreak, hasQuestion);
        if (streakHit) fixStreak = 0;
      }

      msgForMaker = guidancePrefix + MP.relayCheckerToMaker(u.unitIndex, bReply.text, bReply.status?.status ?? "NEEDS_FIX");
    }

    u.status = "failed";
    this.save();
    publishThreadEvent(this.config, {
      jobId: this.state.jobId,
      unitId: u.unitId,
      actor: u.checkerLabel,
      state: "blocked",
      phase: `${u.unitId} 회차 한도 초과`,
      round: u.round,
    });
  }

  private async run(): Promise<MultiJobState> {
    const { config, recorder, state } = this;
    const signal = this.abort.signal;
    const runtimes: UnitRuntime[] = [];
    const leaderC = new LeaderSessionC(config, recorder, state.workspace);

    try {
      if (!fs.existsSync(state.workspace)) {
        fs.mkdirSync(state.workspace, { recursive: true });
      }
      recorder.event("multi_job_start", {
        request: state.request,
        workspace: state.workspace,
        max_units: state.maxUnits,
        mode: config.threads.defaultMode,
      });

      const prepared = await prepareAttachments(state.attachments, path.join(recorder.jobDir, "attachments"), {
        vision: (["A", "B", "C"] as const).some((r) => modelFor(config, r).vision !== false),
        maxImages: config.attachments.maxImages,
        maxImageBytes: config.attachments.maxImageMB * 1024 * 1024,
        pdfPages: config.attachments.pdfPages,
      });
      state.attachmentNotes = prepared.notes;
      state.warnings.push(...prepared.warnings);
      const imagesFor = (r: "A" | "B" | "C"): ContentPart[] => (modelFor(config, r).vision === false ? [] : prepared.images);

      // 1단계: 중심 코어 C가 작업을 스레드 유닛([A1·B1], [A2·B2]...)으로 분해
      this.save("C(중심 코어)가 스레드 분할 계획 수립 중");
      publishThreadEvent(config, {
        jobId: state.jobId,
        unitId: "C",
        actor: "C",
        state: "working",
        phase: "C(중심 코어)가 스레드 분할 계획 수립 중",
      });

      const planJson = await leaderC.askJson(
        MP.planUnitsPromptForC(
          state.request,
          state.workspace,
          state.maxUnits,
          config.threads.defaultMode,
          state.attachmentNotes,
        ),
        signal,
        false,
        imagesFor("C"),
      );

      state.mode = String(planJson.mode).toLowerCase() === "compete" ? "compete" : "split";
      state.overallCriteria = Array.isArray(planJson.overall_done_criteria)
        ? planJson.overall_done_criteria.map(String)
        : [state.request];
      state.definitions = Array.isArray(planJson.definitions) ? planJson.definitions.map(String) : [];

      const rawUnits = Array.isArray(planJson.units) && planJson.units.length > 0
        ? planJson.units.slice(0, state.maxUnits)
        : [{ title: "기본 구현", target_files: [], instruction: state.request, done_criteria: state.overallCriteria }];

      // 2단계: 각 스레드 유닛마다 독립 작업 공간(Git Worktree) 및 전담 [A_n + B_n] 세션 생성
      for (let i = 0; i < rawUnits.length; i++) {
        const idx = i + 1;
        const uRaw = rawUnits[i] as Record<string, unknown>;
        const unitId = `unit-${idx}`;
        const ws = createUnitWorkspace(state.workspace, recorder.jobDir, state.jobId, unitId, config);
        const unitConfig: CkdConfig = { ...config, defaultWorkspace: ws.unitPath };

        const uState: ThreadUnitState = {
          unitId,
          unitIndex: idx,
          makerLabel: `A${idx}`,
          checkerLabel: `B${idx}`,
          title: String(uRaw.title ?? `스레드 유닛 ${idx}`),
          targetFiles: Array.isArray(uRaw.target_files) ? uRaw.target_files.map(String) : [],
          instruction: String(uRaw.instruction ?? state.request),
          doneCriteria: Array.isArray(uRaw.done_criteria) && uRaw.done_criteria.length > 0
            ? uRaw.done_criteria.map(String)
            : state.overallCriteria,
          status: "pending",
          round: 0,
          changedFiles: [],
          diffPreview: "",
          branchName: ws.branchName,
          logs: [],
        };
        state.units.push(uState);

        const maker = new RoleSession(
          "A",
          modelFor(unitConfig, "A"),
          MP.systemPromptMakerAn(unitConfig, idx),
          unitConfig,
          recorder,
          ws.unitPath,
          ["DONE", "WORKING", "QUESTION"],
          undefined,
          { label: `A${idx}`, toolProfile: "maker" },
        );
        const checker = new RoleSession(
          "B",
          modelFor(unitConfig, "B"),
          MP.systemPromptCheckerBn(unitConfig, idx),
          unitConfig,
          recorder,
          ws.unitPath,
          ["DONE", "NEEDS_FIX", "QUESTION"],
          undefined,
          { label: `B${idx}`, toolProfile: "checker" },
        );

        spawnHerdrUnitPane(config, unitId, uState.title, ws.unitPath);
        runtimes.push({ state: uState, ws, maker, checker });
      }

      recorder.event("units_planned", {
        mode: state.mode,
        unit_count: runtimes.length,
        units: state.units.map((u) => ({ id: u.unitId, title: u.title, targetFiles: u.targetFiles })),
      });

      // 3단계: 다중 스레드 병렬 실행 및 C의 통합 판정 루프 (1회 = [A_n ⇄ B_n 완료] → C 통합 검증)
      // maxRounds === 0 이면 완료(PASS)될 때까지 무한 반복, > 0 이면 지정된 횟수(예: 10회)까지 반복
      let reworkMap = new Map<string, string>();
      const maxOuterRounds = config.maxRounds > 0 ? config.maxRounds : 0;

      while (true) {
        if (maxOuterRounds > 0 && state.round >= maxOuterRounds) {
          state.status = "limit_reached";
          state.error = `통합 회차 한도(${maxOuterRounds}회)에 도달했습니다.`;
          break;
        }
        state.round++;
        const targets = state.round === 1
          ? runtimes
          : runtimes.filter(
              (rt) =>
                reworkMap.has(rt.state.unitId) ||
                (rt.state.status !== "done" && rt.state.status !== "merged" && rt.state.status !== "selected"),
            );

        if (state.round > 1) {
          for (const rt of targets) {
            syncUnitWithMain(rt.ws);
          }
        }

        if (this.config.threads.parallelUnits === false) {
          this.save(`${state.round}차 통합 실행: ${targets.length}개 스레드 유닛([A·B]) 순차 가동 중 (저사양 GPU VRAM 보호)`);
          for (const rt of targets) {
            if (signal.aborted) break;
            await this.runUnitLoop(rt, signal, imagesFor("A"), imagesFor("B"), reworkMap.get(rt.state.unitId));
          }
        } else {
          this.save(`${state.round}차 통합 실행: ${targets.length}개 스레드 유닛([A·B]) 병렬 가동 중`);
          await Promise.all(
            targets.map((rt) =>
              this.runUnitLoop(rt, signal, imagesFor("A"), imagesFor("B"), reworkMap.get(rt.state.unitId)),
            ),
          );
        }
        reworkMap = new Map();

        // 분업(split) 모드면 통과한 유닛들을 메인 폴더로 병합
        if (state.mode === "split") {
          let mergeFailed = false;
          for (const rt of runtimes) {
            if (rt.state.status === "done") {
              const merged = applyUnitToMain(rt.ws, `${rt.state.unitId}: ${rt.state.title}`);
              if (!merged.ok) {
                mergeFailed = true;
                reworkMap.set(
                  rt.state.unitId,
                  `메인 브랜치 병합 중 충돌이 발생했습니다 (${merged.conflicts.join(", ") || merged.error}). 충돌 파일 범위를 정리해 다시 작업하세요.`,
                );
                rt.state.status = "working";
              } else {
                rt.state.status = "merged";
              }
            } else {
              mergeFailed = true;
              reworkMap.set(rt.state.unitId, "이전 회차에서 미완료된 요구사항을 마무리하세요.");
            }
          }
          if (mergeFailed && (maxOuterRounds === 0 || state.round < maxOuterRounds)) {
            continue;
          }
        }

        // 4단계: 중심 코어 C의 최종 통합 검증(split) 또는 우승 유닛 선택(compete)
        this.save("C(중심 코어)가 최종 통합 검증 및 판정 중");
        publishThreadEvent(config, {
          jobId: state.jobId,
          unitId: "C",
          actor: "C",
          state: "working",
          phase: "C(중심 코어)가 최종 통합 검증 및 판정 중",
        });

        const summaries = runtimes.map((rt) => ({
          unitId: rt.state.unitId,
          title: rt.state.title,
          rounds: rt.state.round,
          passed: rt.state.status === "done" || rt.state.status === "merged",
          aReport: rt.state.lastMaker?.text ?? "",
          bReview: rt.state.lastChecker?.text ?? "",
          changedFiles: rt.state.changedFiles,
        }));

        const verdict = await leaderC.askJson(
          MP.judgeIntegrationPromptForC(
            state.request,
            state.mode,
            state.overallCriteria,
            state.definitions,
            summaries,
          ),
          signal,
          state.mode === "split",
        );

        const unmet = Array.isArray(verdict.criteria_check)
          ? verdict.criteria_check.filter((c) => c && typeof c === "object" && (c as Record<string, unknown>).met === false)
          : [];
        const pass = String(verdict.verdict).toUpperCase() === "PASS" && unmet.length === 0;
        state.lastJudge = { verdict: pass ? "PASS" : "FAIL", reason: String(verdict.reason ?? "") };
        recorder.event("multi_judge", { round: state.round, ...verdict });

        if (pass) {
          // 경쟁(compete) 모드면 C가 선택한 우승 유닛만 메인 작업 폴더에 반영
          if (state.mode === "compete") {
            const desiredId = String(verdict.winner_unit_id ?? "");
            const winner = runtimes.find((rt) => rt.state.unitId === desiredId) ??
              runtimes.find((rt) => rt.state.status === "done") ??
              runtimes[0];
            if (winner) {
              applyUnitToMain(winner.ws, `Winner ${winner.state.unitId}: ${winner.state.title}`);
              winner.state.status = "selected";
              state.winnerUnitId = winner.state.unitId;
            }
          }

          state.report = String(verdict.report_for_user ?? verdict.reason ?? "모든 스레드 작업 및 통합 검증을 완료했습니다.");
          if (!config.requireReview) {
            state.status = "completed";
            break;
          }

          state.status = "awaiting_review";
          this.save("C 및 모든 [A·B] 스레드 완료 — 최종 확인 대기");
          publishThreadEvent(config, {
            jobId: state.jobId,
            unitId: "C",
            actor: "C",
            state: "blocked",
            phase: "최종 확인(accept/rework) 대기 중",
          });
          this.notifyPaused();
          const rev = await this.waitForReview(signal);
          state.reviews.push({ ...rev, round: state.round, at: new Date().toISOString() });
          if (rev.decision === "accept") {
            state.status = "completed";
            break;
          }

          state.status = "running";
          for (const rt of runtimes) {
            reworkMap.set(rt.state.unitId, `최종 확인자 수정 요청: ${rev.note}`);
          }
          continue;
        }

        // FAIL 시 C가 지목한 유닛들에 수정 지시 배정
        const reworks = Array.isArray(verdict.rework_units) ? verdict.rework_units : [];
        if (reworks.length > 0) {
          for (const item of reworks) {
            const o = item as Record<string, unknown>;
            const uid = String(o.unit_id ?? "");
            const inst = String(o.instruction ?? state.lastJudge.reason);
            if (uid) reworkMap.set(uid, inst);
          }
        }
        if (reworkMap.size === 0) {
          for (const rt of runtimes) {
            reworkMap.set(rt.state.unitId, state.lastJudge.reason || "통합 조건 미충족 항목을 보완하세요.");
          }
        }
      }
    } catch (err) {
      state.status = signal.aborted ? "stopped" : "failed";
      state.error = signal.aborted ? "사용자가 중지했습니다." : (err as Error).message;
      recorder.event("multi_job_error", { error: state.error });
    } finally {
      // 5단계 (필수 자동 정리): 로컬 Worktree 및 GitHub 원격 임시 브랜치 즉시 정리
      let cleanedCount = 0;
      for (const rt of runtimes) {
        cleanupUnitWorkspace(rt.ws, config);
        cleanedCount++;
      }
      pruneOldRemoteBranches(state.workspace, config);

      // 파인튜닝 데이터 기록 (curateLogs=ON일 때만 수집 · 경쟁 모드에서는 우승=preferred, 비우승=non_preferred)
      if (config.curateLogs) {
        const baseMeta = {
          engine: "herdr-multi",
          mode: state.mode,
          outcome: state.status,
          rounds: state.round,
        };
        leaderC.exportFinetune(baseMeta);
        for (const rt of runtimes) {
          const isWinner = state.mode === "compete" ? state.winnerUnitId === rt.state.unitId : rt.state.status === "merged";
          const unitMeta = {
            ...baseMeta,
            unit_id: rt.state.unitId,
            unit_rounds: rt.state.round,
            preference_tag: isWinner ? "preferred" : "non_preferred",
          };
          rt.maker.exportFinetune(unitMeta);
          rt.checker.exportFinetune(unitMeta);
        }
      }

      if (config.curateLogs && !signal.aborted) {
        try {
          const facts = inspectJob(recorder.jobDir);
          const record = {
            job_id: state.jobId,
            engine: "herdr-multi",
            mode: state.mode,
            unit_count: state.units.length,
            winner_unit_id: state.winnerUnitId ?? null,
            request: state.request,
            outcome: state.status,
            rounds: state.round,
            summary: state.report ?? state.error ?? "",
            suggested_label: state.status === "completed" ? "good" : "bad",
            facts_summary: factsText(facts).slice(0, 2000),
            human_verdict: null,
            training_label: null,
          };
          fs.writeFileSync(path.join(recorder.jobDir, "curation.json"), JSON.stringify(record, null, 2));
          rebuildCurated(config.dataDir);
        } catch {
          // ignore curation error
        }
      }

      state.finishedAt = new Date().toISOString();
      try {
        const finetuneDir = path.join(config.dataDir, "finetune");
        fs.mkdirSync(finetuneDir, { recursive: true });
        fs.appendFileSync(
          path.join(finetuneDir, "jobs.jsonl"),
          JSON.stringify({
            job_id: state.jobId,
            engine: "herdr-multi",
            mode: state.mode,
            request: state.request,
            outcome: state.status,
            rounds: state.round,
            units: state.units.length,
            winner_unit_id: state.winnerUnitId ?? null,
            finished_at: state.finishedAt,
          }) + "\n",
          "utf8",
        );
      } catch {
        // ignore jobs.jsonl write error
      }

      // 6단계 (필수 로그 용량 관리): 임시 백업(original/worktrees) 삭제 + 오래된 jobs 순차 삭제
      cleanupJobTemp(recorder.jobDir, config.retention.deleteTempOnComplete);
      const retentionRes = this.onFinishCleanup
        ? this.onFinishCleanup(state.jobId)
        : enforceLogRetention(config, new Set());

      state.cleanupSummary = {
        worktreesCleaned: cleanedCount,
        deletedOldJobs: retentionRes.deletedJobs,
        freedBytes: retentionRes.freedBytes,
      };

      this.save(state.status === "completed" ? "완료" : state.status);
      publishThreadEvent(config, {
        jobId: state.jobId,
        unitId: "C",
        actor: "C",
        state: state.status === "completed" ? "done" : "idle",
        phase: state.status === "completed" ? "통합 완료" : `종료 (${state.status})`,
      });
      this.notifyPaused();
    }

    return state;
  }
}

export class MultiJobManager {
  private jobs = new Map<string, MultiJob>();

  constructor(private config: CkdConfig) {}

  updateConfig(nextConfig: CkdConfig): void {
    this.config = nextConfig;
  }

  getConfig(): CkdConfig {
    return this.config;
  }

  start(opts: Omit<StartMultiJobOptions, "workspace"> & { workspace?: string }): MultiJob {
    const ws = opts.workspace ?? this.config.defaultWorkspace;
    if (!ws) throw new Error("작업 폴더(workspace)를 지정해 주세요.");
    const job = new MultiJob(this.config, { ...opts, workspace: ws }, (finishedId) => {
      const activeIds = new Set<string>();
      for (const [id, j] of this.jobs.entries()) {
        if (id !== finishedId && (j.state.status === "running" || j.state.status === "awaiting_review")) {
          activeIds.add(id);
        }
      }
      return enforceLogRetention(this.config, activeIds);
    });
    this.jobs.set(job.state.jobId, job);
    return job;
  }

  get(jobId: string): MultiJob | undefined {
    return this.jobs.get(jobId);
  }

  getActiveJobIds(): Set<string> {
    const active = new Set<string>();
    for (const [id, j] of this.jobs.entries()) {
      if (j.state.status === "running" || j.state.status === "awaiting_review") {
        active.add(id);
      }
    }
    return active;
  }

  evictDeletedJobs(): void {
    const jobsDir = path.join(this.config.dataDir, "jobs");
    for (const [id, j] of this.jobs.entries()) {
      if (j.state.status === "running" || j.state.status === "awaiting_review") continue;
      if (!fs.existsSync(path.join(jobsDir, id, "state.json"))) {
        this.jobs.delete(id);
      }
    }
  }

  listStates(): MultiJobState[] {
    this.evictDeletedJobs();
    const map = new Map<string, MultiJobState>();
    const jobsDir = path.join(this.config.dataDir, "jobs");
    if (fs.existsSync(jobsDir)) {
      for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
        const stFile = path.join(jobsDir, entry.name, "state.json");
        if (fs.existsSync(stFile)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(stFile, "utf8"));
            if (parsed.engine === "herdr-multi") map.set(entry.name, parsed);
          } catch {
            // ignore
          }
        }
      }
    }
    for (const [id, j] of this.jobs.entries()) {
      map.set(id, j.state);
    }
    return [...map.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  readState(jobId: string): MultiJobState | undefined {
    const live = this.jobs.get(jobId);
    if (live) return live.state;
    const file = path.join(this.config.dataDir, "jobs", jobId, "state.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
  }
}
