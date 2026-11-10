#!/usr/bin/env node
// CKD MCP 서버 (stdio). Claude Code, LM Studio 등 MCP를 지원하는 앱에 등록해서 쓴다.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSearchKeys } from "./web.js";
import { loadConfig, modelFor, ROLE_NAMES, saveConfigFile, type Role } from "./config.js";
import { ensureDesktopDataDir, readSoulAndCatalog, resolveCatalogPreset } from "./ui-server.js";
import { listModels } from "./llm.js";
import { JobManager, refineCuration, type JobState } from "./orchestrator.js";
import { MultiJobManager, type MultiJobState } from "./multi-orchestrator.js";
import { getStorageStats, purgeAllCompletedLogs } from "./retention.js";
import { applyFeedback, type HumanVerdict } from "./curation.js";

// 검색 키는 CKD_ENV_FILE의 .env에서 실행할 때만 읽는다 (설정 파일과 기록에는 남기지 않음).
loadSearchKeys(process.env.CKD_ENV_FILE);
ensureDesktopDataDir();
let config = loadConfig();
const jobs = new JobManager(config);
const multiJobs = new MultiJobManager(config);

function uiBaseUrl(): string {
  const host = config.uiHost === "0.0.0.0" ? "127.0.0.1" : config.uiHost || "127.0.0.1";
  const port = Number(process.env.HERDR_CKD_PORT ?? config.uiPort ?? 37501);
  return `http://${host}:${port}`;
}

async function tryCallLiveUi(path: string, method = "GET", body?: Record<string, any>): Promise<any | null> {
  try {
    const res = await fetch(`${uiBaseUrl()}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const { soul: initialSoul, catalog: initialCatalog } = readSoulAndCatalog();
const server = new McpServer(
  { name: "herdr-ckd", version: "0.2.0" },
  {
    instructions: `${initialSoul}\n\n---\n\n${initialCatalog}`,
  },
);

server.registerResource(
  "soul",
  "ckd://soul",
  {
    title: "Herdr CKD 에이전트 영혼 및 자율 지휘 헌장 (SOUL.md)",
    description: "MCP로 연결된 AI 에이전트의 정체성, C + [A_n·B_n] 3권분립 헌법, 대시보드 UI 전권 자율 조작 지침",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [{ uri: "ckd://soul", mimeType: "text/markdown", text: readSoulAndCatalog().soul }],
  }),
);

server.registerResource(
  "catalog",
  "ckd://catalog",
  {
    title: "Herdr CKD 이기종 AI 조합 · GPU 프로파일 · UI 자동제어 카탈로그 (CATALOG.md)",
    description: "C(유료/로컬) + A·B(로컬/유료) 하이브리드 모델 프리셋, 저사양 GPU 보호 모드, UI 원격 조작 명령어 카탈로그",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [{ uri: "ckd://catalog", mimeType: "text/markdown", text: readSoulAndCatalog().catalog }],
  }),
);

function describe(state: JobState): string {
  const lines = [
    `작업 ID: ${state.jobId}`,
    `상태: ${state.status} (${state.phase})`,
    `회차: ${state.round}${state.maxRounds > 0 ? ` / 최대 ${state.maxRounds}회` : " (회차 제한 없음)"}`,
  ];
  // 4곳의 완료 상태: A, B, C, 연결된 AI(최종 확인자)
  const lastReview = state.reviews?.at(-1);
  lines.push(
    `완료 선언: A ${state.lastA?.status === "DONE" ? "완료" : "아직"} · B ${state.lastB?.status === "DONE" ? "완료" : "아직"} · C ${state.lastJudge?.verdict === "PASS" ? "완료" : "아직"} · 연결된 AI ${state.status === "completed" && lastReview?.decision === "accept" ? "완료" : state.status === "awaiting_review" ? "확인 대기 (ckd_review로 accept 또는 rework)" : lastReview ? `다시 하기 요청(${lastReview.round}회차)` : "아직"}`,
  );
  if (state.parentJobId) lines.push(`이어서 맡긴 원래 작업: ${state.parentJobId}`);
  if (state.status === "limit_reached") lines.push(`${state.maxRounds}회 한도에 도달해 멈췄습니다. 완료로 판정되지는 않았습니다.`);
  if (state.lastA) lines.push(`A(Maker) 마지막 상태: ${state.lastA.status ?? "형식 오류"} ${state.lastA.summary ?? ""}`);
  if (state.lastB) lines.push(`B(Checker) 마지막 상태: ${state.lastB.status ?? "형식 오류"} ${state.lastB.summary ?? ""}`);
  if (state.lastJudge) lines.push(`C(Relay) 마지막 판단: ${state.lastJudge.verdict} ${state.lastJudge.reason}`);
  for (const w of state.warnings ?? []) lines.push(`주의: ${w}`);
  if (state.report) lines.push("", state.status === "limit_reached" ? "C(Relay)의 한도 도달 보고:" : "C(Relay)의 완료 보고:", state.report);
  if (state.error) lines.push("", `중단 사유: ${state.error}`);
  return lines.join("\n");
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

server.registerTool(
  "ckd_run",
  {
    title: "CKD로 작업 시작",
    description:
      "A(Maker)가 개발하고 B(Checker)가 검수하며 C(Relay)가 전달과 최종 판단을 하는 CKD 협업을 시작합니다. " +
      "기본으로 바로 작업 ID를 돌려주고 뒤에서 진행합니다. 진행 상황은 ckd_status로 확인하세요.",
    inputSchema: {
      request: z.string().describe("사용자가 원하는 작업 내용"),
      workspace: z.string().optional().describe("A가 작업할 폴더의 절대 경로. 생략하면 설정의 defaultWorkspace"),
      wait: z.boolean().optional().describe("true면 완료될 때까지 기다렸다가 결과를 돌려줌"),
      attachments: z
        .array(z.string())
        .optional()
        .describe("사용자가 첨부한 파일의 절대 경로 (참고 이미지 png/jpg/gif/webp, 문서 등). 이미지는 C·A·B에게 그림으로 전달되고, 문서는 읽기 전용으로 열립니다"),
      read_paths: z.array(z.string()).optional().describe("작업 폴더 밖이지만 A·B가 읽어야 하는 폴더의 절대 경로 (예: 실제 데이터 폴더)"),
      parent_job_id: z.string().optional().describe("끝난 작업을 이어서 다시 맡길 때 원래 작업 ID (기록 연결용)"),
      max_rounds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("이 작업의 최대 회차 (A 작업→B 검수→C 판정이 1회차, 첫 회차 포함). 사용자가 \"10회로\"처럼 횟수를 말했을 때만 넣으세요. 0이나 생략이면 제한 없음(설정의 maxRounds가 기본값)"),
    },
  },
  async ({ request, workspace, wait, read_paths, attachments, max_rounds, parent_job_id }) => {
    const job = jobs.start(request, workspace, read_paths, attachments, max_rounds, parent_job_id);
    // wait: A·B·C가 끝내고 연결된 AI의 확인을 기다리는 때(또는 작업이 끝날 때)까지 기다린다.
    if (wait) return text(describe(await job.paused()));
    const stopNote = job.state.maxRounds > 0 ? "" : "\n회차 제한 없이 완료될 때까지 반복합니다. 멈추려면 ckd_stop에 이 작업 ID를 넣어 부르세요.";
    return text(`CKD 작업을 시작했습니다.\n${describe(job.state)}${stopNote}`);
  },
);

server.registerTool(
  "ckd_status",
  {
    title: "CKD 진행 상황",
    description: "CKD 작업의 현재 상태를 봅니다. 완료되면 C(Relay)의 보고가 포함됩니다.",
    inputSchema: { job_id: z.string() },
  },
  async ({ job_id }) => {
    const liveMulti = multiJobs.get(job_id);
    if (liveMulti) return text(describeMulti(liveMulti.state));
    const state = jobs.readState(job_id);
    if (!state) return text(`작업을 찾을 수 없습니다: ${job_id}`);
    if ((state as unknown as MultiJobState).engine === "herdr-multi") {
      return text(describeMulti(state as unknown as MultiJobState));
    }
    return text(describe(state));
  },
);

server.registerTool(
  "ckd_review",
  {
    title: "CKD 결과를 연결된 AI가 최종 확인",
    description:
      "A·B·C가 모두 완료라고 해서 확인 대기(awaiting_review) 중인 작업을, 부른 쪽(연결된 AI)이 결과물을 직접 실행·확인한 뒤 판정합니다. accept면 4곳 모두 완료로 끝나고, rework면 note의 지적을 C가 A에게 전해 같은 작업이 다음 회차로 이어집니다(회차 한도 그대로 적용). 학습용 표시는 이 판정이 아니라 ckd_feedback(사람 판정)으로만 정해집니다.",
    inputSchema: {
      job_id: z.string(),
      decision: z.enum(["accept", "rework"]),
      note: z.string().optional().describe("rework면 무엇이 아직 안 됐는지 구체적으로 (accept면 확인한 내용)"),
    },
  },
  async ({ job_id, decision, note }) => {
    const multiJob = multiJobs.get(job_id);
    if (multiJob) {
      const refused = multiJob.review(decision, note ?? "");
      if (refused) return text(refused);
      if (decision === "accept") return text(describeMulti(await multiJob.done));
      await new Promise((r) => setTimeout(r, 50));
      return text(`다시 하기를 전했습니다. 다중 스레드 작업이 다음 회차로 이어집니다.\n${describeMulti(multiJob.state)}`);
    }
    const job = jobs.get(job_id);
    if (!job) {
      const saved = jobs.readState(job_id);
      if (saved?.status === "awaiting_review") {
        return text(`서버가 다시 시작되어 이 작업의 A·B·C 세션이 없습니다. 이어서 하려면 ckd_run에 parent_job_id: "${job_id}"를 넣어 지적과 함께 새로 맡기세요.`);
      }
      return text(saved ? `이 작업은 확인 대기 상태가 아닙니다 (지금 상태: ${saved.status}).` : `작업이 없습니다: ${job_id}`);
    }
    const refused = job.review(decision, note ?? "");
    if (refused) return text(refused);
    if (decision === "accept") return text(describe(await job.done));
    // 다시 하기: 다음 확인 대기나 끝날 때까지 기다리지 않고 바로 돌려준다.
    await new Promise((r) => setTimeout(r, 50));
    return text(`다시 하기를 전했습니다. 같은 작업이 다음 회차로 이어집니다. ckd_status로 확인하세요.\n${describe(job.state)}`);
  },
);

server.registerTool(
  "ckd_feedback",
  {
    title: "CKD 작업에 사람 판정 붙이기",
    description:
      "끝난 CKD 작업의 결과물을 사람이 확인한 판정을 기록합니다. C의 정리(suggested_label)는 제안일 뿐이고, 학습용 표시(training_label)는 이 판정으로 정해집니다: correct → good, partial → partial, incorrect → bad.",
    inputSchema: {
      job_id: z.string(),
      verdict: z.enum(["correct", "partial", "incorrect"]),
      note: z.string().optional().describe("무엇이 맞고 틀렸는지 짧은 메모"),
      refine: z.boolean().optional().describe("true(기본)면 판정을 받은 C가 처음 정리를 기록 사실과 판정에 맞춰 다시 정리함"),
    },
  },
  async ({ job_id, verdict, note, refine }) => {
    try {
      let record = applyFeedback(config.dataDir, job_id, verdict as HumanVerdict, note ?? "");
      let refined = "";
      if (refine !== false) {
        try {
          record = await refineCuration(config, job_id);
          const corrections = Array.isArray(record.corrections) ? record.corrections.map(String) : [];
          refined = `\nC가 다시 정리했습니다. 고친 점: ${corrections.length ? corrections.join(" / ") : "없음"}\n요약: ${record.summary ?? ""}`;
        } catch (err) {
          refined = `\nC의 다시 정리는 실패했습니다: ${(err as Error).message}`;
        }
      }
      return text(`판정을 기록했습니다: ${job_id} → ${verdict} (학습용 표시: ${record.training_label}, C의 제안: ${record.suggested_label ?? "없음"})${refined}`);
    } catch (err) {
      return text(`판정을 기록하지 못했습니다: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "ckd_stop",
  {
    title: "CKD 작업 중지",
    description: "진행 중인 CKD 작업을 중지합니다. 이미 실행된 파일 변경은 되돌리지 않습니다.",
    inputSchema: { job_id: z.string() },
  },
  async ({ job_id }) => {
    const multiJob = multiJobs.get(job_id);
    if (multiJob) {
      multiJob.stop();
      return text(describeMulti(await multiJob.done));
    }
    const job = jobs.get(job_id);
    if (!job) return text(`진행 중인 작업이 아닙니다: ${job_id}`);
    job.stop();
    return text(describe(await job.done));
  },
);

server.registerTool(
  "ckd_check_models",
  {
    title: "CKD 모델 연결 확인",
    description: "A·B·C 역할별로 설정된 모델 서버에 연결되는지, 모델이 올라가 있는지 확인합니다.",
    inputSchema: {},
  },
  async () => {
    const lines: string[] = [];
    for (const role of ["A", "B", "C"] as Role[]) {
      const m = modelFor(config, role);
      try {
        const models = await listModels(m);
        const found = models.includes(m.model);
        lines.push(`${role}(${ROLE_NAMES[role]}): ${m.backend} ${m.baseUrl} 모델 ${m.model} ${found ? "확인됨" : `없음 (서버에 있는 모델: ${models.join(", ") || "없음"})`}`);
      } catch (err) {
        lines.push(`${role}(${ROLE_NAMES[role]}): ${m.baseUrl} 연결 실패: ${(err as Error).message}`);
      }
    }
    return text(lines.join("\n"));
  },
);

server.registerPrompt(
  "ckd",
  {
    title: "CKD로 작업해줘",
    description: "CKD 협업으로 작업을 맡깁니다.",
    argsSchema: { request: z.string().describe("작업 내용") },
  },
  ({ request }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `ckd_run 도구로 다음 작업을 CKD에 맡기고, ckd_status로 완료될 때까지 확인한 뒤 C(Relay)의 보고를 그대로 전해 주세요.\n\n작업: ${request}`,
        },
      },
    ],
  }),
);

function describeMulti(state: MultiJobState): string {
  const lines = [
    `[Herdr CKD 다중 스레드 작업] ID: ${state.jobId}`,
    `상태: ${state.status} (${state.phase}) · 모드: ${state.mode} · 통합 회차: ${state.round}`,
    `스레드 유닛 수: ${state.units.length}개`,
  ];
  for (const u of state.units) {
    lines.push(
      `  - [${u.unitId}] ${u.title} (${u.makerLabel}·${u.checkerLabel}): ${u.status} (${u.round}회차, 변경 파일: ${u.changedFiles.length}개)`,
    );
  }
  if (state.winnerUnitId) lines.push(`경쟁 채택 유닛: ${state.winnerUnitId}`);
  if (state.lastJudge) lines.push(`C(중심 코어) 판정: ${state.lastJudge.verdict} — ${state.lastJudge.reason}`);
  if (state.report) lines.push("", "최종 보고:", state.report);
  if (state.error) lines.push("", `오류/중단 사유: ${state.error}`);
  return lines.join("\n");
}

server.registerTool(
  "ckd_multi_run",
  {
    title: "Herdr CKD 다중 스레드 작업 시작",
    description:
      "중심 코어 C(1개 고정)가 작업을 분할·지휘하고, [A1·B1], [A2·B2]... 스레드 세트가 Git Worktree에서 병렬로 구현·전담검수하는 Herdr CKD를 실행합니다.",
    inputSchema: {
      request: z.string().describe("사용자가 원하는 작업 내용"),
      workspace: z.string().optional().describe("작업할 폴더의 절대 경로"),
      max_units: z.number().int().min(1).max(8).optional().describe("동시 실행할 최대 [A·B] 스레드 유닛 수 (기본 3, 저사양 GPU는 1 권장)"),
      mode: z.enum(["auto", "split", "compete"]).optional().describe("실행 모드: auto(자동 판단), split(분업), compete(경쟁)"),
      parallel_units: z.boolean().optional().describe("true(기본)=동시 병렬 실행, false=저사양 단일 GPU VRAM 보호를 위해 1유닛씩 순차 실행"),
      wait: z.boolean().optional().describe("true면 완료 또는 확인 대기까지 기다림"),
      attachments: z.array(z.string()).optional(),
      read_paths: z.array(z.string()).optional(),
      max_rounds: z.number().int().min(0).optional(),
    },
  },
  async ({ request, workspace, max_units, mode, parallel_units, wait, attachments, read_paths, max_rounds }) => {
    if (!wait) {
      const liveRes = await tryCallLiveUi("/api/jobs/start", "POST", {
        request,
        workspace: workspace ?? config.defaultWorkspace,
        maxUnits: max_units ?? config.threads.maxUnits,
        mode: mode ?? config.threads.defaultMode,
        parallelUnits: parallel_units ?? config.threads.parallelUnits ?? true,
        maxRounds: max_rounds,
      });
      if (liveRes?.job) {
        return text(`Herdr CKD 다중 스레드 작업을 시작했습니다 (열려 있는 대시보드 UI 실시간 연동됨).\n${describeMulti(liveRes.job)}`);
      }
    }
    const job = multiJobs.start({
      request,
      workspace,
      maxUnits: max_units,
      mode,
      parallelUnits: parallel_units,
      attachments,
      readPaths: read_paths,
      maxRounds: max_rounds,
    });
    if (wait) return text(describeMulti(await job.paused()));
    return text(`Herdr CKD 다중 스레드 작업을 시작했습니다.\n${describeMulti(job.state)}`);
  },
);

server.registerTool(
  "ckd_multi_status",
  {
    title: "Herdr CKD 다중 스레드 진행 상황",
    description: "다중 스레드 작업(C + A1·B1, A2·B2...)의 현재 상태와 Git Diff를 조회합니다. job_id 생략 시 최신 작업을 조회합니다.",
    inputSchema: {
      job_id: z.string().optional().describe("조회할 작업 ID (생략 시 최신 작업)"),
      include_diff: z.boolean().optional().describe("true면 스레드 유닛별 Git Diff를 함께 표시"),
    },
  },
  async ({ job_id, include_diff }) => {
    const targetId = job_id?.trim() || multiJobs.listStates()[0]?.jobId;
    if (!targetId) return text("아직 실행된 다중 스레드 작업이 없습니다.");
    const st = multiJobs.readState(targetId);
    if (!st) return text(`다중 스레드 작업을 찾을 수 없습니다: ${targetId}`);
    let out = describeMulti(st);
    if (include_diff) {
      for (const u of st.units) {
        out += `\n\n--- [${u.unitId}] Git Diff ---\n${u.diffPreview || "(변경 내역 없음)"}`;
      }
    }
    return text(out);
  },
);

server.registerTool(
  "ckd_configure",
  {
    title: "Herdr CKD 설정 조회 및 변경 (모델·포트·호스트·GitHub·자동삭제)",
    description:
      "IDE에서 Herdr CKD 설정을 조회하거나 즉시 변경합니다. 내부망/로컬 호스트(uiHost), 전용 포트(uiPort, 기본 37501), 중심 코어 C 및 A·B 공유 모델/URL, 기본 작업 폴더(defaultWorkspace), 스레드 수, GitHub 자동 삭제, 로그 보관 한도를 제어합니다.",
    inputSchema: {
      leaderModel: z.string().optional().describe("중심 코어 C 모델 이름 (예: gpt-4.1, gemini-2.5-pro, local-model)"),
      leaderUrl: z.string().optional().describe("중심 코어 C 서버 Base URL"),
      leaderApiKey: z.string().optional().describe("중심 코어 C 전용 유료 API Key (로컬 LLM은 생략)"),
      workerModel: z.string().optional().describe("A·B 공유 모델 이름 (예: local-model, llama3.3, gpt-4.1-mini)"),
      workerUrl: z.string().optional().describe("A·B 공유 모델 서버 Base URL (로컬·내부망·클라우드)"),
      workerApiKey: z.string().optional().describe("A·B 공유 모델 전용 유료 API Key (로컬 LLM은 생략)"),
      defaultWorkspace: z.string().optional().describe("기본 작업 폴더 절대 경로"),
      customRules: z.string().optional().describe("사용자 지정 커스텀 작업/코딩 규칙 (C, A_n, B_n 모두에게 자동 적용)"),
      maxUnits: z.number().int().min(1).max(8).optional(),
      defaultMode: z.enum(["auto", "split", "compete"]).optional(),
      useWorktree: z.boolean().optional(),
      parallelUnits: z.boolean().optional().describe("true(기본)=동시 병렬 실행, false=저사양 단일 GPU VRAM 보호 순차 실행"),
      githubMode: z.enum(["off", "push_on_complete", "pr_on_review"]).optional(),
      maxRemoteBranches: z.number().int().min(1).max(50).optional(),
      deleteBranchOnComplete: z.boolean().optional(),
      maxJobsToKeep: z.number().int().min(1).max(500).optional(),
      maxLogSizeMB: z.number().min(10).max(10000).optional(),
      maxFinetuneSizeMB: z.number().min(10).max(5000).optional(),
      maxRounds: z.number().int().min(0).optional().describe("기본 최대 통합 회차 (0이면 완료될 때까지 무한 반복, 10이면 최대 10회)"),
      uiHost: z.string().optional().describe("UI 및 HTTP MCP 바인딩 호스트 (예: 127.0.0.1 또는 내부망 0.0.0.0)"),
      uiPort: z.number().int().min(1024).max(65535).optional().describe("UI 및 HTTP MCP 전용 포트 (기본 37501)"),
    },
  },
  async (patch) => {
    const hasChanges = Object.values(patch).some((v) => v !== undefined);
    if (hasChanges) {
      await tryCallLiveUi("/api/settings", "POST", patch as Record<string, any>);
      config = loadConfig();
      if (patch.defaultWorkspace !== undefined) config.defaultWorkspace = patch.defaultWorkspace || undefined;
      if (patch.customRules !== undefined) config.customRules = patch.customRules;
      if (patch.maxRounds !== undefined) config.maxRounds = Math.max(0, Math.floor(patch.maxRounds));
      if (patch.uiHost !== undefined) config.uiHost = patch.uiHost.trim() || "127.0.0.1";
      if (patch.uiPort !== undefined) config.uiPort = patch.uiPort;
      if (patch.workerModel !== undefined) config.model.model = patch.workerModel.trim();
      if (patch.workerUrl !== undefined) config.model.baseUrl = patch.workerUrl.trim();
      if (patch.workerApiKey !== undefined && patch.workerApiKey !== "***") {
        config.model.apiKey = patch.workerApiKey.trim() || undefined;
      }
      if (patch.leaderModel !== undefined || patch.leaderUrl !== undefined || patch.leaderApiKey !== undefined) {
        config.roleModels.C = {
          ...config.roleModels.C,
          ...(patch.leaderModel !== undefined ? { model: patch.leaderModel.trim() } : {}),
          ...(patch.leaderUrl !== undefined ? { baseUrl: patch.leaderUrl.trim() } : {}),
          ...(patch.leaderApiKey !== undefined && patch.leaderApiKey !== "***"
            ? { apiKey: patch.leaderApiKey.trim() || undefined }
            : {}),
        };
      }
      if (patch.maxUnits !== undefined) config.threads.maxUnits = patch.maxUnits;
      if (patch.defaultMode !== undefined) config.threads.defaultMode = patch.defaultMode;
      if (patch.useWorktree !== undefined) config.threads.useWorktree = patch.useWorktree;
      if (patch.parallelUnits !== undefined) config.threads.parallelUnits = patch.parallelUnits;
      if (patch.githubMode !== undefined) config.github.mode = patch.githubMode;
      if (patch.maxRemoteBranches !== undefined) config.github.maxRemoteBranches = patch.maxRemoteBranches;
      if (patch.deleteBranchOnComplete !== undefined) config.github.deleteBranchOnComplete = patch.deleteBranchOnComplete;
      if (patch.maxJobsToKeep !== undefined) config.retention.maxJobsToKeep = patch.maxJobsToKeep;
      if (patch.maxLogSizeMB !== undefined) config.retention.maxLogSizeMB = patch.maxLogSizeMB;
      if (patch.maxFinetuneSizeMB !== undefined) config.retention.maxFinetuneSizeMB = patch.maxFinetuneSizeMB;
      saveConfigFile(config);
      multiJobs.updateConfig(config);
    } else {
      config = loadConfig();
    }
    const leader = modelFor(config, "C");
    const worker = modelFor(config, "A");
    return text(
      [
        hasChanges ? "✅ Herdr CKD 설정을 변경하여 저장했습니다." : "📋 현재 Herdr CKD 설정:",
        `- 내부망/로컬 바인딩: http://${config.uiHost}:${config.uiPort} (MCP 엔드포인트: http://${config.uiHost}:${config.uiPort}/mcp)`,
        `- 기본 작업 폴더(defaultWorkspace): ${config.defaultWorkspace ?? "(미지정)"}`,
        `- 중심 코어 C 모델: ${leader.model} (${leader.baseUrl}) [API Key: ${leader.apiKey ? "설정됨" : "로컬/없음"}]`,
        `- 스레드 공유 A·B 모델: ${worker.model} (${worker.baseUrl}) [API Key: ${worker.apiKey ? "설정됨" : "로컬/없음"}]`,
        `- 스레드 설정: 최대 ${config.threads.maxUnits}유닛 · 기본 모드 ${config.threads.defaultMode} · 실행방식=${config.threads.parallelUnits === false ? "순차(저사양 GPU 보호)" : "병렬(동시 가동)"} · Worktree=${config.threads.useWorktree}`,
        `- GitHub 연동: 모드=${config.github.mode} · 완료 시 자동삭제=${config.github.deleteBranchOnComplete} · 최대 브랜치=${config.github.maxRemoteBranches}개`,
        `- 로그 순차 삭제: 최대 ${config.retention.maxJobsToKeep}개 (${config.retention.maxLogSizeMB} MB) · 파인튜닝 최대 ${config.retention.maxFinetuneSizeMB} MB`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "ckd_multi_review",
  {
    title: "Herdr CKD 다중 스레드 결과 최종 확인",
    description: "확인 대기(awaiting_review) 중인 다중 스레드 작업을 accept 또는 rework로 판정합니다.",
    inputSchema: {
      job_id: z.string(),
      decision: z.enum(["accept", "rework"]),
      note: z.string().optional().describe("rework 시 수정 요청 내용"),
    },
  },
  async ({ job_id, decision, note }) => {
    const job = multiJobs.get(job_id);
    if (!job) {
      const saved = multiJobs.readState(job_id);
      return text(saved ? `이 작업은 확인 대기 상태가 아닙니다 (지금 상태: ${saved.status}).` : `다중 스레드 작업이 없습니다: ${job_id}`);
    }
    const refused = job.review(decision, note ?? "");
    if (refused) return text(refused);
    if (decision === "accept") return text(describeMulti(await job.done));
    await new Promise((r) => setTimeout(r, 50));
    return text(`다시 하기를 전했습니다. 다중 스레드 작업이 다음 회차로 이어집니다.\n${describeMulti(job.state)}`);
  },
);

server.registerTool(
  "ckd_multi_stop",
  {
    title: "Herdr CKD 다중 스레드 작업 중지",
    description: "진행 중인 다중 스레드 작업을 중지합니다.",
    inputSchema: { job_id: z.string() },
  },
  async ({ job_id }) => {
    const job = multiJobs.get(job_id);
    if (!job) return text(`진행 중인 다중 스레드 작업이 아닙니다: ${job_id}`);
    job.stop();
    return text(describeMulti(await job.done));
  },
);

server.registerTool(
  "ckd_ui_control",
  {
    title: "Herdr CKD 대시보드 UI 전체 자율 조작 및 카탈로그 프리셋 적용",
    description:
      "MCP로 연결된 AI가 사용자를 대신해 열려 있는 Herdr CKD 대시보드 UI 전체를 실시간으로 조작합니다. 좌측 입력란 채우기(set_form), 활성 작업 전환(select_job), 스레드 필터 탭 전환(set_filter), 유닛별 Git Diff 열기/닫기(toggle_diff), SOUL/CATALOG 프리셋 원클릭 적용(apply_preset), 모델 연결 확인 배너 띄우기(check_models), 설정 모달 열기/닫기(open_settings/close_settings), 또는 SOUL.md·CATALOG.md 전문 조회(get_soul_and_catalog)를 수행합니다.",
    inputSchema: {
      action: z
        .enum([
          "set_form",
          "select_job",
          "set_filter",
          "set_search",
          "zoom_unit",
          "toggle_diff",
          "apply_preset",
          "check_models",
          "open_settings",
          "close_settings",
          "get_soul_and_catalog",
        ])
        .describe("수행할 대시보드 UI 제어 액션"),
      preset: z
        .string()
        .optional()
        .describe(
          "apply_preset일 때 적용할 카탈로그 ID (예: hybrid_openai_local, hybrid_gemini_local, hybrid_claude_local, local_lmstudio, local_ollama, cloud_openai, cloud_gemini, gpu_high_parallel, gpu_low_sequential, gpu_minimal_single)",
        ),
      workspace: z.string().optional(),
      request: z.string().optional(),
      mode: z.enum(["auto", "split", "compete"]).optional(),
      maxUnits: z.number().int().min(1).max(8).optional(),
      parallelUnits: z.boolean().optional(),
      maxRounds: z.number().int().min(0).optional(),
      jobId: z.string().optional(),
      filter: z.enum(["all", "working", "checking", "blocked", "done"]).optional(),
      search: z.string().optional(),
      unitId: z.string().optional(),
      open: z.boolean().optional(),
    },
  },
  async (args) => {
    if (args.action === "get_soul_and_catalog") {
      const docs = readSoulAndCatalog();
      return text(`${docs.soul}\n\n---\n\n${docs.catalog}`);
    }
    if (args.action === "apply_preset" && args.preset) {
      const patch = resolveCatalogPreset(args.preset);
      if (!patch) {
        return text(`알 수 없는 프리셋 ID입니다: ${args.preset}`);
      }
      await tryCallLiveUi("/api/ui/control", "POST", args as Record<string, any>);
      config = loadConfig();
      return text(`✅ 카탈로그 프리셋 [${args.preset}]을 대시보드 UI 및 설정에 즉시 적용했습니다.`);
    }
    await tryCallLiveUi("/api/ui/control", "POST", args as Record<string, any>);
    return text(`✅ 대시보드 UI 원격 제어 명령(${args.action})을 실시간 전송했습니다.`);
  },
);

server.registerTool(
  "ckd_cleanup_logs",
  {
    title: "CKD 로그 및 임시 데이터 용량 정리",
    description: "쌓여 있는 오래된 작동 로그(jobs/)와 임시 폴더를 설정 한도에 맞춰 순차 삭제합니다.",
    inputSchema: {},
  },
  async () => {
    const liveClean = await tryCallLiveUi("/api/cleanup", "POST", {});
    if (liveClean?.report && liveClean?.storage) {
      return text(
        `정리 완료: 삭제된 작업 ${liveClean.report.deletedJobs.length}개, 확보 용량 ${(liveClean.report.freedBytes / (1024 * 1024)).toFixed(2)} MB\n` +
          `현재 보관 중: 작업 ${liveClean.storage.jobCount}개 (${liveClean.storage.jobsMB} MB), 파인튜닝 기록 ${liveClean.storage.finetuneMB} MB`,
      );
    }
    const report = purgeAllCompletedLogs(config, multiJobs.getActiveJobIds());
    multiJobs.evictDeletedJobs();
    const stats = getStorageStats(config.dataDir);
    return text(
      `정리 완료: 삭제된 작업 ${report.deletedJobs.length}개, 확보 용량 ${(report.freedBytes / (1024 * 1024)).toFixed(2)} MB\n` +
        `현재 보관 중: 작업 ${stats.jobCount}개 (${stats.jobsMB} MB), 파인튜닝 기록 ${stats.finetuneMB} MB`,
    );
  },
);

await server.connect(new StdioServerTransport());
