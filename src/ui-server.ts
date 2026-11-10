#!/usr/bin/env node
// Herdr CKD 스레드 분리 데스크톱 UI 서버 (Windows EXE / macOS App 런처 겸용)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  loadConfig,
  modelFor,
  ROLE_NAMES,
  saveConfigFile,
  type CkdConfig,
  type GithubSyncMode,
  type ModelConfig,
  type Role,
  type ThreadExecutionMode,
} from "./config.js";
import { listModels } from "./llm.js";
import { applyFeedback, curationFile, type HumanVerdict } from "./curation.js";
import { loadSearchKeys } from "./web.js";
import { MultiJobManager, type MultiJobState } from "./multi-orchestrator.js";
import {
  enforceLogRetention,
  exportFinetuneDataset,
  getFinetuneSummary,
  getStorageStats,
  purgeAllCompletedLogs,
  resetFinetuneDirectory,
} from "./retention.js";
import { liveBus, publishUiAction, type ThreadLiveEvent, type UiRemoteActionEvent } from "./herdr-bridge.js";
import { renderDashboardHtml } from "./ui-html.js";

export function resolveAppRoot(): string {
  return process.env.HERDR_APP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function readSoulAndCatalog(): { soul: string; catalog: string } {
  const root = resolveAppRoot();
  const soulFile = path.join(root, "SOUL.md");
  const catalogFile = path.join(root, "CATALOG.md");
  const soul = fs.existsSync(soulFile)
    ? fs.readFileSync(soulFile, "utf8")
    : "# Herdr CKD SOUL\nC(1개 고정 중심 코어) + [A_n·B_n](다중 구현·전담검수 스레드) 3권분립 오케스트레이터.";
  const catalog = fs.existsSync(catalogFile)
    ? fs.readFileSync(catalogFile, "utf8")
    : "# Herdr CKD CATALOG\nPreset IDs: hybrid_openai_local, hybrid_gemini_local, hybrid_claude_local, local_lmstudio, local_ollama, cloud_openai, cloud_gemini, gpu_high_parallel, gpu_low_sequential, gpu_minimal_single";
  return { soul, catalog };
}

export function resolveCatalogPreset(presetId: string): Record<string, any> | null {
  const map: Record<string, Record<string, any>> = {
    hybrid_openai_local: {
      leaderModel: "gpt-4.1",
      leaderUrl: "https://api.openai.com/v1",
      workerModel: "local-model",
      workerUrl: "http://localhost:1234/v1",
      workerApiKey: "",
    },
    hybrid_gemini_local: {
      leaderModel: "gemini-2.5-pro",
      leaderUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      workerModel: "local-model",
      workerUrl: "http://localhost:1234/v1",
      workerApiKey: "",
    },
    hybrid_claude_local: {
      leaderModel: "anthropic/claude-sonnet-4",
      leaderUrl: "https://openrouter.ai/api/v1",
      workerModel: "local-model",
      workerUrl: "http://localhost:1234/v1",
      workerApiKey: "",
    },
    local_lmstudio: {
      leaderModel: "local-model",
      leaderUrl: "http://localhost:1234/v1",
      leaderApiKey: "",
      workerModel: "local-model",
      workerUrl: "http://localhost:1234/v1",
      workerApiKey: "",
    },
    local_ollama: {
      leaderModel: "llama3.3",
      leaderUrl: "http://localhost:11434/v1",
      leaderApiKey: "",
      workerModel: "llama3.3",
      workerUrl: "http://localhost:11434/v1",
      workerApiKey: "",
    },
    cloud_openai: {
      leaderModel: "gpt-4.1",
      leaderUrl: "https://api.openai.com/v1",
      workerModel: "gpt-4.1-mini",
      workerUrl: "https://api.openai.com/v1",
    },
    cloud_gemini: {
      leaderModel: "gemini-2.5-pro",
      leaderUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      workerModel: "gemini-2.5-flash",
      workerUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    gpu_high_parallel: {
      maxUnits: 3,
      parallelUnits: true,
    },
    gpu_low_sequential: {
      maxUnits: 3,
      parallelUnits: false,
    },
    gpu_minimal_single: {
      maxUnits: 1,
      parallelUnits: false,
    },
  };
  return map[presetId.trim()] ?? null;
}

export function ensureDesktopDataDir(): void {
  if (!process.env.CKD_DATA_DIR && !process.env.CKD_CONFIG) {
    const appRoot = resolveAppRoot();
    const defaultDir = path.resolve(appRoot, "herdr-ckd-data");
    fs.mkdirSync(defaultDir, { recursive: true });
    const cfgFile = path.join(defaultDir, "ckd.config.json");
    if (!fs.existsSync(cfgFile)) {
      fs.writeFileSync(
        cfgFile,
        JSON.stringify(
          {
            requireReview: false,
            uiHost: "127.0.0.1",
            uiPort: 37501,
            threads: { maxUnits: 3, defaultMode: "auto", useWorktree: true },
            github: {
              mode: "off",
              remote: "origin",
              branchPrefix: "ckd",
              deleteBranchOnComplete: true,
              maxRemoteBranches: 5,
            },
            retention: {
              deleteTempOnComplete: true,
              maxJobsToKeep: 30,
              maxLogSizeMB: 500,
              maxFinetuneSizeMB: 200,
            },
            herdr: {
              enabled: true,
              emitOsc7501: true,
              autoSpawnPanes: false,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    process.env.CKD_DATA_DIR = defaultDir;
  }
}

function listenOnce(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function listenWithFallback(
  server: http.Server,
  desiredPort: number,
  desiredHost = "127.0.0.1",
): Promise<number> {
  const host = desiredHost.trim() || "127.0.0.1";
  if (desiredPort > 0) {
    try {
      await listenOnce(server, desiredPort, host);
    } catch {
      await listenOnce(server, 0, host);
    }
  } else {
    await listenOnce(server, 0, host);
  }
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : desiredPort;
}

function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) reject(new Error("요청 본문이 너무 큽니다."));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

interface RoleModelProbeResult {
  role: "C" | "A·B";
  url: string;
  model: string;
  ok: boolean;
  matched: boolean;
  availableModels: string[];
  error: string | null;
}

async function probeRoleModel(role: "C" | "A·B", cfg: ModelConfig): Promise<RoleModelProbeResult> {
  const url = cfg.baseUrl ?? "";
  const model = cfg.model;
  try {
    const availableModels = await listModels(cfg);
    const targetLower = model.toLowerCase();
    const matched = availableModels.some((id) => {
      const idLower = id.toLowerCase();
      return id === model || idLower.includes(targetLower) || targetLower.includes(idLower);
    });
    return {
      role,
      url,
      model,
      ok: true,
      matched,
      availableModels,
      error: null,
    };
  } catch (err) {
    return {
      role,
      url,
      model,
      ok: false,
      matched: false,
      availableModels: [],
      error: (err as Error).message,
    };
  }
}

function readJobCuration(dataDir: string, jobId: string): Record<string, unknown> | null {
  try {
    const file = curationFile(dataDir, jobId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stripMaskedApiKey<T extends Record<string, any> | undefined>(obj: T): Partial<ModelConfig> {
  if (!obj || typeof obj !== "object") return {};
  const copy: Record<string, any> = { ...obj };
  if (copy.apiKey === "***") delete copy.apiKey;
  return copy as Partial<ModelConfig>;
}

function applyConfigPatch(config: CkdConfig, body: Record<string, any>): CkdConfig {
  const nextDefaultWorkspace =
    body.defaultWorkspace !== undefined
      ? String(body.defaultWorkspace).trim() || undefined
      : config.defaultWorkspace;
  const nextCustomRules =
    body.customRules !== undefined ? String(body.customRules) : (config.customRules ?? "");

  const rawMaxUnits = body.threads?.maxUnits ?? body.maxUnits;
  const rawDefaultMode = body.threads?.defaultMode ?? body.defaultMode;
  const rawUseWorktree = body.threads?.useWorktree ?? body.useWorktree;
  const rawParallelUnits = body.threads?.parallelUnits ?? body.parallelUnits;
  const validMode: ThreadExecutionMode =
    rawDefaultMode === "auto" || rawDefaultMode === "split" || rawDefaultMode === "compete"
      ? rawDefaultMode
      : config.threads.defaultMode;

  const rawEmitOsc = body.herdr?.emitOsc7501 ?? body.emitOsc7501;
  const rawHerdrEnabled = body.herdr?.enabled ?? body.herdrEnabled;
  const rawAutoSpawnPanes = body.herdr?.autoSpawnPanes ?? body.autoSpawnPanes;

  const prevRetention = config.retention as CkdConfig["retention"] & { maxFinetuneSizeMB?: number };
  const rawMaxJobs = body.retention?.maxJobsToKeep ?? body.maxJobsToKeep;
  const rawMaxLogMB = body.retention?.maxLogSizeMB ?? body.maxLogSizeMB;
  const rawDeleteTemp = body.retention?.deleteTempOnComplete ?? body.deleteTempOnComplete;
  const rawMaxFinetuneMB = body.retention?.maxFinetuneSizeMB ?? body.maxFinetuneSizeMB;

  const nextRetention: CkdConfig["retention"] & { maxFinetuneSizeMB?: number } = {
    ...prevRetention,
    maxJobsToKeep: rawMaxJobs !== undefined ? Math.max(1, Number(rawMaxJobs)) : prevRetention.maxJobsToKeep,
    maxLogSizeMB: rawMaxLogMB !== undefined ? Math.max(10, Number(rawMaxLogMB)) : prevRetention.maxLogSizeMB,
    deleteTempOnComplete:
      rawDeleteTemp !== undefined ? Boolean(rawDeleteTemp) : prevRetention.deleteTempOnComplete,
  };
  if (rawMaxFinetuneMB !== undefined) {
    nextRetention.maxFinetuneSizeMB = Math.max(1, Number(rawMaxFinetuneMB));
  } else if (prevRetention.maxFinetuneSizeMB !== undefined) {
    nextRetention.maxFinetuneSizeMB = prevRetention.maxFinetuneSizeMB;
  }

  const rawCurateLogs = body.curateLogs ?? body.finetuneEnabled;
  const nextCurateLogs = rawCurateLogs !== undefined ? Boolean(rawCurateLogs) : config.curateLogs;

  const modelPatch = stripMaskedApiKey(body.model);
  const nextWorkerModel = String(body.workerModel || modelPatch.model || config.model.model).trim();
  const nextWorkerUrl = String(
    body.workerUrl || modelPatch.baseUrl || config.model.baseUrl || "http://localhost:1234/v1",
  ).trim();
  const nextWorkerApiKey =
    body.workerApiKey !== undefined && body.workerApiKey !== "***"
      ? String(body.workerApiKey).trim() || undefined
      : modelPatch.apiKey ?? config.model.apiKey;

  const roleCPatch = stripMaskedApiKey(body.roleModels?.C);
  const prevRoleC = config.roleModels.C ?? {};
  const nextLeaderModel = String(
    body.leaderModel || roleCPatch.model || prevRoleC.model || nextWorkerModel,
  ).trim();
  const nextLeaderUrl = String(
    body.leaderUrl || roleCPatch.baseUrl || prevRoleC.baseUrl || nextWorkerUrl,
  ).trim();
  const nextLeaderApiKey =
    body.leaderApiKey !== undefined && body.leaderApiKey !== "***"
      ? String(body.leaderApiKey).trim() || undefined
      : roleCPatch.apiKey ?? prevRoleC.apiKey;

  const rawGithubMode = body.github?.mode ?? body.githubMode;
  const rawMaxBranches = body.github?.maxRemoteBranches ?? body.maxRemoteBranches;
  const rawDeleteBranch = body.github?.deleteBranchOnComplete ?? body.deleteBranchOnComplete;
  const rawRemote = body.github?.remote ?? body.githubRemote;
  const rawBranchPrefix = body.github?.branchPrefix ?? body.branchPrefix;

  const nextUiHost =
    body.uiHost !== undefined ? String(body.uiHost).trim() || "127.0.0.1" : config.uiHost || "127.0.0.1";
  const nextUiPort =
    body.uiPort !== undefined && Number(body.uiPort) > 0
      ? Math.max(1024, Math.min(65535, Number(body.uiPort)))
      : config.uiPort || 37501;

  const nextMaxRounds =
    body.maxRounds !== undefined
      ? Math.max(0, Math.floor(Number(body.maxRounds)))
      : config.maxRounds;

  return {
    ...config,
    defaultWorkspace: nextDefaultWorkspace,
    customRules: nextCustomRules,
    curateLogs: nextCurateLogs,
    maxRounds: nextMaxRounds,
    uiHost: nextUiHost,
    uiPort: nextUiPort,
    model: {
      ...config.model,
      ...modelPatch,
      model: nextWorkerModel,
      baseUrl: nextWorkerUrl,
      apiKey: nextWorkerApiKey,
    },
    roleModels: {
      ...config.roleModels,
      C: {
        ...prevRoleC,
        ...roleCPatch,
        model: nextLeaderModel,
        baseUrl: nextLeaderUrl,
        apiKey: nextLeaderApiKey,
      },
    },
    threads: {
      ...config.threads,
      maxUnits:
        rawMaxUnits !== undefined
          ? Math.max(1, Math.min(8, Number(rawMaxUnits)))
          : config.threads.maxUnits,
      defaultMode: validMode,
      useWorktree: rawUseWorktree !== undefined ? Boolean(rawUseWorktree) : config.threads.useWorktree,
      parallelUnits:
        rawParallelUnits !== undefined ? Boolean(rawParallelUnits) : (config.threads.parallelUnits ?? true),
    },
    herdr: {
      ...config.herdr,
      enabled: rawHerdrEnabled !== undefined ? Boolean(rawHerdrEnabled) : config.herdr.enabled,
      emitOsc7501: rawEmitOsc !== undefined ? Boolean(rawEmitOsc) : config.herdr.emitOsc7501,
      autoSpawnPanes:
        rawAutoSpawnPanes !== undefined ? Boolean(rawAutoSpawnPanes) : config.herdr.autoSpawnPanes,
    },
    github: {
      ...config.github,
      mode: (rawGithubMode as GithubSyncMode) ?? config.github.mode,
      remote: rawRemote !== undefined ? String(rawRemote).trim() || "origin" : config.github.remote,
      branchPrefix:
        rawBranchPrefix !== undefined ? String(rawBranchPrefix).trim() || "ckd" : config.github.branchPrefix,
      maxRemoteBranches:
        rawMaxBranches !== undefined
          ? Math.max(1, Number(rawMaxBranches))
          : config.github.maxRemoteBranches,
      deleteBranchOnComplete:
        rawDeleteBranch !== undefined ? Boolean(rawDeleteBranch) : config.github.deleteBranchOnComplete,
    },
    retention: nextRetention as CkdConfig["retention"],
  };
}

function describeMultiJob(state: MultiJobState): string {
  const lines = [
    `[Herdr CKD 다중 스레드 작업] ID: ${state.jobId}`,
    `상태: ${state.status} (${state.phase}) · 모드: ${state.mode} · 통합 회차: ${state.round}`,
    `작업 폴더: ${state.workspace}`,
    `스레드 유닛 수: ${state.units.length}개`,
  ];
  for (const u of state.units) {
    lines.push(
      `  - [${u.unitId}] ${u.title} (${u.makerLabel}·${u.checkerLabel}): ${u.status} (${u.round}회차, 변경 파일: ${u.changedFiles.join(", ") || "없음"})`,
    );
  }
  if (state.winnerUnitId) lines.push(`경쟁 채택 유닛: ${state.winnerUnitId}`);
  if (state.lastJudge) lines.push(`C(중심 코어) 판정: ${state.lastJudge.verdict} — ${state.lastJudge.reason}`);
  if (state.report) lines.push("", "최종 보고:", state.report);
  if (state.error) lines.push("", `오류/중단 사유: ${state.error}`);
  return lines.join("\n");
}

function createHttpMcpServer(
  getConfig: () => CkdConfig,
  updateConfig: (patch: Record<string, any>) => CkdConfig,
  manager: MultiJobManager,
): McpServer {
  const { soul, catalog } = readSoulAndCatalog();
  const mcp = new McpServer(
    { name: "herdr-ckd", version: "0.2.0" },
    {
      instructions: `${soul}\n\n---\n\n${catalog}`,
    },
  );
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  mcp.registerResource(
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

  mcp.registerResource(
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

  mcp.registerTool(
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
        workspace: z.string().optional().describe("set_form일 때 작업 폴더 입력란에 채울 경로"),
        request: z.string().optional().describe("set_form일 때 작업 지시 입력란에 채울 텍스트"),
        mode: z.enum(["auto", "split", "compete"]).optional().describe("set_form일 때 스레드 편성 모드"),
        maxUnits: z.number().int().min(1).max(8).optional().describe("set_form일 때 [A·B] 스레드 유닛 수"),
        parallelUnits: z.boolean().optional().describe("set_form일 때 병렬(true) 또는 저사양 GPU 순차(false) 선택"),
        maxRounds: z.number().int().min(0).optional().describe("set_form일 때 최대 통합 회차"),
        jobId: z.string().optional().describe("select_job일 때 선택할 작업 ID"),
        filter: z.enum(["all", "working", "checking", "blocked", "done"]).optional().describe("set_filter일 때 전환할 탭 (blocked=확인·수정 필요 스레드)"),
        search: z.string().optional().describe("set_search일 때 스레드·파일·로그 검색어 (빈 문자열이면 초기화)"),
        unitId: z.string().optional().describe("toggle_diff 또는 zoom_unit일 때 대상 유닛 ID (예: unit-1, unit-2, all, 또는 빈 문자열)"),
        open: z.boolean().optional().describe("toggle_diff 또는 zoom_unit일 때 true면 열기/확대, false면 닫기/축소 (생략 시 토글)"),
      },
    },
    async (args) => {
      if (args.action === "get_soul_and_catalog") {
        const docs = readSoulAndCatalog();
        return text(`${docs.soul}\n\n---\n\n${docs.catalog}`);
      }
      if (args.action === "apply_preset") {
        const presetId = (args.preset ?? "").trim();
        const patch = resolveCatalogPreset(presetId);
        if (!patch) {
          return text(
            `알 수 없는 프리셋 ID입니다: ${presetId}\n사용 가능한 프리셋: hybrid_openai_local, hybrid_gemini_local, hybrid_claude_local, local_lmstudio, local_ollama, cloud_openai, cloud_gemini, gpu_high_parallel, gpu_low_sequential, gpu_minimal_single`,
          );
        }
        const next = updateConfig(patch);
        publishUiAction({
          uiAction: "set_form",
          maxUnits: next.threads.maxUnits,
          parallelUnits: next.threads.parallelUnits,
          mode: next.threads.defaultMode,
        });
        const leader = modelFor(next, "C");
        const worker = modelFor(next, "A");
        return text(
          `✅ 카탈로그 프리셋 [${presetId}]을 대시보드 UI 및 설정에 즉시 적용했습니다.\n- 중심 코어 C: ${leader.model} (${leader.baseUrl})\n- 스레드 공유 A·B: ${worker.model} (${worker.baseUrl})\n- 스레드 가동: 최대 ${next.threads.maxUnits}세트 · ${next.threads.parallelUnits === false ? "🐢 순차 실행 (저사양 GPU 보호)" : "⚡ 병렬 동시 실행"}`,
        );
      }
      publishUiAction({
        uiAction: args.action,
        workspace: args.workspace,
        request: args.request,
        mode: args.mode,
        maxUnits: args.maxUnits,
        parallelUnits: args.parallelUnits,
        maxRounds: args.maxRounds,
        jobId: args.jobId,
        filter: args.filter,
        search: args.search,
        unitId: args.unitId,
        open: args.open,
      });
      return text(`✅ 대시보드 UI 원격 제어 명령(${args.action})을 실시간 전송했습니다.`);
    },
  );

  mcp.registerTool(
    "ckd_multi_run",
    {
      title: "Herdr CKD 다중 스레드 작업 시작",
      description:
        "IDE(Gemini/Claude 등)에서 Herdr CKD 다중 스레드 작업을 지시합니다. 중심 코어 C(1개 고정)가 작업을 분할·지휘하고 [A1·B1], [A2·B2]... 스레드 세트가 Git Worktree에서 병렬로 구현·전담검수하며, 열려 있는 Herdr CKD 데스크톱 대시보드 UI에 실시간으로 표시됩니다.",
      inputSchema: {
        request: z.string().describe("사용자가 원하는 작업 내용"),
        workspace: z.string().optional().describe("작업할 폴더의 절대 경로 (생략 시 defaultWorkspace)"),
        max_units: z.number().int().min(1).max(8).optional().describe("동시 실행할 최대 [A·B] 스레드 유닛 수 (기본 3, 저사양 GPU는 1 권장)"),
        mode: z.enum(["auto", "split", "compete"]).optional().describe("실행 모드: auto(자동 판단), split(분업), compete(경쟁)"),
        parallel_units: z.boolean().optional().describe("true(기본)=[A·B] 유닛 동시 병렬 실행, false=저사양 단일 GPU VRAM 보호를 위해 1유닛씩 순차 실행"),
        wait: z.boolean().optional().describe("true면 완료 또는 확인 대기까지 기다림"),
        attachments: z.array(z.string()).optional(),
        read_paths: z.array(z.string()).optional(),
        max_rounds: z.number().int().min(0).optional(),
      },
    },
    async ({ request, workspace, max_units, mode, parallel_units, wait, attachments, read_paths, max_rounds }) => {
      const cfg = getConfig();
      const targetWs = (workspace ?? cfg.defaultWorkspace ?? "").trim();
      if (!targetWs) {
        return text("오류: 작업할 폴더(workspace) 절대 경로를 지정하거나 ckd_configure로 defaultWorkspace를 먼저 설정해 주세요.");
      }
      const job = manager.start({
        request,
        workspace: targetWs,
        maxUnits: max_units ?? cfg.threads.maxUnits,
        mode: mode ?? cfg.threads.defaultMode,
        parallelUnits: parallel_units ?? cfg.threads.parallelUnits ?? true,
        attachments,
        readPaths: read_paths,
        maxRounds: max_rounds,
      });
      publishUiAction({
        uiAction: "set_form",
        workspace: targetWs,
        request,
        mode: mode ?? cfg.threads.defaultMode,
        maxUnits: max_units ?? cfg.threads.maxUnits,
        parallelUnits: parallel_units ?? cfg.threads.parallelUnits ?? true,
        maxRounds: max_rounds ?? cfg.maxRounds,
        jobId: job.state.jobId,
      });
      if (wait) return text(describeMultiJob(await job.paused()));
      return text(`Herdr CKD 다중 스레드 작업을 시작했습니다 (대시보드 UI 실시간 연동됨).\n${describeMultiJob(job.state)}`);
    },
  );

  mcp.registerTool(
    "ckd_multi_status",
    {
      title: "Herdr CKD 다중 스레드 진행 상황 및 Diff 조회",
      description: "다중 스레드 작업(C + A1·B1, A2·B2...)의 현재 상태, 유닛별 로그, Git Diff를 조회합니다. job_id를 생략하면 가장 최근 작업을 보여줍니다.",
      inputSchema: {
        job_id: z.string().optional().describe("조회할 작업 ID (생략 시 최신 작업)"),
        include_diff: z.boolean().optional().describe("true면 각 스레드 유닛의 Git Diff 미리보기를 함께 출력"),
      },
    },
    async ({ job_id, include_diff }) => {
      const targetId = job_id?.trim() || manager.listStates()[0]?.jobId;
      if (!targetId) return text("아직 실행된 다중 스레드 작업이 없습니다.");
      const st = manager.readState(targetId);
      if (!st) return text(`다중 스레드 작업을 찾을 수 없습니다: ${targetId}`);
      let out = describeMultiJob(st);
      if (include_diff) {
        for (const u of st.units) {
          out += `\n\n--- [${u.unitId}] Git Diff ---\n${u.diffPreview || "(변경 내역 없음)"}`;
        }
      }
      return text(out);
    },
  );

  mcp.registerTool(
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
      const job = manager.get(job_id);
      if (!job) {
        const saved = manager.readState(job_id);
        return text(saved ? `이 작업은 확인 대기 상태가 아닙니다 (지금 상태: ${saved.status}).` : `다중 스레드 작업이 없습니다: ${job_id}`);
      }
      const refused = job.review(decision, note ?? "");
      if (refused) return text(refused);
      if (decision === "accept") return text(describeMultiJob(await job.done));
      await new Promise((r) => setTimeout(r, 50));
      return text(`다시 하기를 전했습니다. 다중 스레드 작업이 다음 회차로 이어집니다.\n${describeMultiJob(job.state)}`);
    },
  );

  mcp.registerTool(
    "ckd_multi_stop",
    {
      title: "Herdr CKD 다중 스레드 작업 중지",
      description: "진행 중인 다중 스레드 작업을 중지합니다.",
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      const job = manager.get(job_id);
      if (!job) return text(`진행 중인 다중 스레드 작업이 아닙니다: ${job_id}`);
      job.stop();
      return text(describeMultiJob(await job.done));
    },
  );

  mcp.registerTool(
    "ckd_configure",
    {
      title: "Herdr CKD 설정 조회 및 변경 (모델·포트·호스트·GitHub·자동삭제)",
      description:
        "IDE에서 Herdr CKD의 설정을 조회하거나 즉시 변경합니다. 내부망 호스트(uiHost), 전용 포트(uiPort), 중심 코어 C 모델/URL, A·B 공유 모델/URL(맥 원격 서버 IP), 기본 작업 폴더(defaultWorkspace), 스레드 수(maxUnits), GitHub 자동 삭제, 로그 보관 한도 등을 조정할 수 있습니다.",
      inputSchema: {
        leaderModel: z.string().optional().describe("중심 코어 C 모델 이름 (예: gpt-4.1, gemini-2.5-pro, local-model)"),
        leaderUrl: z.string().optional().describe("중심 코어 C 서버 Base URL (예: https://api.openai.com/v1 또는 http://localhost:1234/v1)"),
        leaderApiKey: z.string().optional().describe("중심 코어 C 전용 유료 API Key (로컬 LLM은 생략 가능)"),
        workerModel: z.string().optional().describe("A·B 공유 모델 이름 (예: local-model, llama3.3, gpt-4.1-mini)"),
        workerUrl: z.string().optional().describe("A·B 공유 모델 서버 Base URL (예: http://localhost:1234/v1)"),
        workerApiKey: z.string().optional().describe("A·B 공유 모델 전용 유료 API Key (로컬 LLM은 생략 가능)"),
        defaultWorkspace: z.string().optional().describe("기본 작업 폴더 절대 경로"),
        customRules: z.string().optional().describe("사용자 지정 커스텀 작업/코딩 규칙 (C, A_n, B_n 모두에게 자동 적용)"),
        maxUnits: z.number().int().min(1).max(8).optional().describe("기본 최대 [A·B] 스레드 유닛 수 (저사양 GPU는 1 권장)"),
        defaultMode: z.enum(["auto", "split", "compete"]).optional().describe("기본 스레드 실행 모드"),
        useWorktree: z.boolean().optional().describe("Git Worktree 격리 사용 여부"),
        parallelUnits: z.boolean().optional().describe("true(기본)=동시 병렬 실행, false=저사양 단일 GPU VRAM 보호 순차 실행"),
        githubMode: z.enum(["off", "push_on_complete", "pr_on_review"]).optional(),
        maxRemoteBranches: z.number().int().min(1).max(50).optional(),
        deleteBranchOnComplete: z.boolean().optional(),
        maxJobsToKeep: z.number().int().min(1).max(500).optional(),
        maxLogSizeMB: z.number().min(10).max(10000).optional(),
        maxFinetuneSizeMB: z.number().min(10).max(5000).optional(),
        maxRounds: z.number().int().min(0).optional().describe("기본 최대 통합 회차 (0이면 완료될 때까지 무한 반복, 10이면 최대 10회)"),
        uiHost: z.string().optional().describe("UI 및 HTTP MCP 바인딩 호스트 (예: 127.0.0.1 또는 내부망 0.0.0.0)"),
        uiPort: z.number().int().min(1024).max(65535).optional().describe("UI 및 HTTP MCP 전용 포트 번호 (기본 37501)"),
      },
    },
    async (patch) => {
      const hasChanges = Object.values(patch).some((v) => v !== undefined);
      const next = hasChanges ? updateConfig(patch as Record<string, any>) : getConfig();
      const leader = modelFor(next, "C");
      const worker = modelFor(next, "A");
      return text(
        [
          hasChanges ? "✅ Herdr CKD 설정을 변경하여 저장했습니다." : "📋 현재 Herdr CKD 설정:",
          `- 내부망/로컬 바인딩: http://${next.uiHost}:${next.uiPort} (MCP 엔드포인트: http://${next.uiHost}:${next.uiPort}/mcp)`,
          `- 기본 작업 폴더(defaultWorkspace): ${next.defaultWorkspace ?? "(미지정)"}`,
          `- 중심 코어 C 모델: ${leader.model} (${leader.baseUrl}) [API Key: ${leader.apiKey ? "설정됨" : "로컬/없음"}]`,
          `- 스레드 공유 A·B 모델: ${worker.model} (${worker.baseUrl}) [API Key: ${worker.apiKey ? "설정됨" : "로컬/없음"}]`,
          `- 스레드 설정: 최대 ${next.threads.maxUnits}유닛 · 기본 모드 ${next.threads.defaultMode} · 실행방식=${next.threads.parallelUnits === false ? "순차(저사양 GPU 보호)" : "병렬(동시 가동)"} · Worktree=${next.threads.useWorktree}`,
          `- GitHub 연동: 모드=${next.github.mode} · 완료 시 자동삭제=${next.github.deleteBranchOnComplete} · 최대 브랜치=${next.github.maxRemoteBranches}개`,
          `- 로그 순차 삭제: 최대 ${next.retention.maxJobsToKeep}개 (${next.retention.maxLogSizeMB} MB) · 파인튜닝 최대 ${next.retention.maxFinetuneSizeMB} MB`,
        ].join("\n"),
      );
    },
  );

  mcp.registerTool(
    "ckd_check_models",
    {
      title: "Herdr CKD 모델 서버 연결 확인",
      description: "중심 코어 C와 스레드 공유 모델 A·B 서버(로컬, 내부망 또는 클라우드 API) 연결 상태를 확인합니다.",
      inputSchema: {},
    },
    async () => {
      const cfg = getConfig();
      const lines: string[] = [];
      for (const role of ["A", "B", "C"] as Role[]) {
        const m = modelFor(cfg, role);
        try {
          const models = await listModels(m);
          const found = models.includes(m.model);
          lines.push(
            `${role}(${ROLE_NAMES[role]}): ${m.backend} ${m.baseUrl} 모델 ${m.model} ${found ? "확인됨" : `없음 (서버 모델: ${models.join(", ") || "없음"})`}`,
          );
        } catch (err) {
          lines.push(`${role}(${ROLE_NAMES[role]}): ${m.baseUrl} 연결 실패: ${(err as Error).message}`);
        }
      }
      return text(lines.join("\n"));
    },
  );

  mcp.registerTool(
    "ckd_feedback",
    {
      title: "Herdr CKD 작업에 사람 판정(파인튜닝 라벨) 기록",
      description: "완료된 작업에 correct(good), partial, incorrect(bad) 판정을 기록하여 finetune/curated.jsonl에 보존합니다.",
      inputSchema: {
        job_id: z.string(),
        verdict: z.enum(["correct", "partial", "incorrect"]),
        note: z.string().optional(),
      },
    },
    async ({ job_id, verdict, note }) => {
      try {
        const cfg = getConfig();
        const record = applyFeedback(cfg.dataDir, job_id, verdict as HumanVerdict, note ?? "");
        return text(`판정을 기록했습니다: ${job_id} → ${verdict} (training_label: ${record.training_label})`);
      } catch (err) {
        return text(`판정 기록 실패: ${(err as Error).message}`);
      }
    },
  );

  mcp.registerTool(
    "ckd_cleanup_logs",
    {
      title: "Herdr CKD 작동 로그 및 임시 폴더 즉시 정리",
      description: "오래된 작동 로그(jobs/)와 임시 폴더를 설정 한도에 맞춰 즉시 순차 삭제합니다.",
      inputSchema: {},
    },
    async () => {
      const cfg = getConfig();
      const report = purgeAllCompletedLogs(cfg, manager.getActiveJobIds());
      manager.evictDeletedJobs();
      const stats = getStorageStats(cfg.dataDir);
      return text(
        `정리 완료: 삭제된 작업 ${report.deletedJobs.length}개, 확보 용량 ${(report.freedBytes / (1024 * 1024)).toFixed(2)} MB\n` +
          `현재 보관 중: 작업 ${stats.jobCount}개 (${stats.jobsMB} MB), 파인튜닝 기록 ${stats.finetuneMB} MB`,
      );
    },
  );

  return mcp;
}

function openNativeWindow(url: string): void {
  if (process.env.NO_OPEN_BROWSER === "1") return;
  if (process.platform === "win32") {
    // Windows에서 주소창 없는 네이티브 앱 창(--app) 우선 실행, 없으면 기본 브라우저 실행
    const edgePaths = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    const edge = edgePaths.find((p) => fs.existsSync(p));
    if (edge) {
      spawn(edge, [`--app=${url}`, "--window-size=1420,900"], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    const chromeApp = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(chromeApp)) {
      spawn(chromeApp, [`--app=${url}`, "--window-size=1420,900"], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

export async function startUiServer(
  customConfig?: CkdConfig,
): Promise<{ server: http.Server; port: number; host: string }> {
  loadSearchKeys(process.env.CKD_ENV_FILE);
  if (!customConfig) ensureDesktopDataDir();
  let config = customConfig ?? loadConfig();
  const manager = new MultiJobManager(config);

  const updateAndSaveConfig = (patch: Record<string, any>): CkdConfig => {
    config = applyConfigPatch(config, patch);
    saveConfigFile(config);
    manager.updateConfig(config);
    return config;
  };

  const sseClients = new Set<http.ServerResponse>();
  const broadcastSse = (payload: unknown) => {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(msg);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  const onLive = (ev: ThreadLiveEvent) => broadcastSse(ev);
  const onUiAction = (ev: UiRemoteActionEvent) => broadcastSse(ev);
  liveBus.on("thread_event", onLive);
  liveBus.on("ui_action", onUiAction);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      // 내장 Streamable HTTP MCP 엔드포인트 (/mcp) — IDE(Antigravity/Gemini/Claude)에서 직접 연결하여 제어
      if (url.pathname === "/mcp") {
        if (req.method === "POST") {
          const parsedBody = await readBody(req);
          const mcpServer = createHttpMcpServer(() => config, updateAndSaveConfig, manager);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await mcpServer.connect(transport);
          res.on("close", () => {
            transport.close().catch(() => {});
            mcpServer.close().catch(() => {});
          });
          await transport.handleRequest(req, res, parsedBody);
          return;
        }
        if (req.method === "GET" || req.method === "DELETE") {
          const mcpServer = createHttpMcpServer(() => config, updateAndSaveConfig, manager);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await mcpServer.connect(transport);
          res.on("close", () => {
            transport.close().catch(() => {});
            mcpServer.close().catch(() => {});
          });
          await transport.handleRequest(req, res);
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderDashboardHtml());
        return;
      }

      if (req.method === "GET" && (url.pathname === "/favicon.ico" || url.pathname === "/icon.svg" || url.pathname === "/icon.png")) {
        const appRoot = resolveAppRoot();
        const fileMap: Record<string, { file: string; mime: string }> = {
          "/favicon.ico": { file: path.join(appRoot, "assets", "herdr-ckd.ico"), mime: "image/x-icon" },
          "/icon.svg": { file: path.join(appRoot, "assets", "herdr-ckd.svg"), mime: "image/svg+xml; charset=utf-8" },
          "/icon.png": { file: path.join(appRoot, "assets", "herdr-ckd.png"), mime: "image/png" },
        };
        const target = fileMap[url.pathname];
        if (target && fs.existsSync(target.file)) {
          res.writeHead(200, { "Content-Type": target.mime, "Cache-Control": "public, max-age=3600" });
          res.end(fs.readFileSync(target.file));
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write('data: {"ready":true}\n\n');
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/overview") {
        const safeConfig = JSON.parse(JSON.stringify(config, (k, v) => (k === "apiKey" ? "***" : v)));
        const jobs = manager
          .listStates()
          .slice(0, 30)
          .map((j) => ({
            ...j,
            curation: readJobCuration(config.dataDir, j.jobId),
          }));
        sendJson(res, 200, {
          config: safeConfig,
          storage: getStorageStats(config.dataDir),
          finetune: getFinetuneSummary(config.dataDir),
          jobs,
        });
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/models/check") {
        const body = req.method === "POST" ? await readBody(req) : {};
        const baseLeader = modelFor(config, "C");
        const baseWorker = modelFor(config, "A");

        const leaderCfg: ModelConfig = {
          ...baseLeader,
          baseUrl: String(body.leaderUrl || baseLeader.baseUrl || "http://localhost:1234/v1").trim(),
          model: String(body.leaderModel || baseLeader.model).trim(),
          apiKey:
            body.leaderApiKey !== undefined && body.leaderApiKey !== "***" && String(body.leaderApiKey).trim()
              ? String(body.leaderApiKey).trim()
              : baseLeader.apiKey,
        };
        const workerCfg: ModelConfig = {
          ...baseWorker,
          baseUrl: String(body.workerUrl || baseWorker.baseUrl || "http://localhost:1234/v1").trim(),
          model: String(body.workerModel || baseWorker.model).trim(),
          apiKey:
            body.workerApiKey !== undefined && body.workerApiKey !== "***" && String(body.workerApiKey).trim()
              ? String(body.workerApiKey).trim()
              : baseWorker.apiKey,
        };

        const [leader, worker] = await Promise.all([
          probeRoleModel("C", leaderCfg),
          probeRoleModel("A·B", workerCfg),
        ]);

        sendJson(res, 200, {
          ok: leader.ok && worker.ok,
          leader,
          worker,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/pick-folder") {
        const picked = await new Promise<string | null>((resolve) => {
          if (process.platform === "win32") {
            const psScript = [
              "Add-Type -AssemblyName System.Windows.Forms;",
              "$f = New-Object System.Windows.Forms.Form;",
              "$f.TopMost = $true;",
              "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
              "$d.Description = 'Herdr CKD 작업 폴더(Workspace)를 선택하세요';",
              "$d.ShowNewFolderButton = $true;",
              "if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
            ].join(" ");
            execFile("powershell", ["-NoProfile", "-Sta", "-Command", psScript], { timeout: 120000 }, (_err, stdout) => {
              const p = String(stdout || "").trim();
              resolve(p || null);
            });
          } else if (process.platform === "darwin") {
            execFile("osascript", ["-e", 'POSIX path of (choose folder with prompt "Select Herdr CKD Workspace Folder")'], { timeout: 120000 }, (_err, stdout) => {
              const p = String(stdout || "").trim();
              resolve(p || null);
            });
          } else {
            resolve(null);
          }
        });
        if (picked) {
          updateAndSaveConfig({ defaultWorkspace: picked });
        }
        sendJson(res, 200, { ok: Boolean(picked), path: picked });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/jobs/start") {
        const body = await readBody(req);
        const request = String(body.request ?? "").trim();
        const workspace = String(body.workspace ?? config.defaultWorkspace ?? "").trim();
        if (!request) {
          sendJson(res, 400, { error: "작업 내용(request)을 입력해 주세요." });
          return;
        }
        if (!workspace) {
          sendJson(res, 400, { error: "작업 폴더(workspace) 절대 경로를 선택하거나 입력해 주세요." });
          return;
        }
        if (workspace !== config.defaultWorkspace) {
          updateAndSaveConfig({ defaultWorkspace: workspace });
        }
        const job = manager.start({
          request,
          workspace,
          mode: body.mode || "auto",
          maxUnits: Number(body.maxUnits || config.threads.maxUnits || 6),
          maxRounds: body.maxRounds !== undefined ? Math.max(0, Number(body.maxRounds)) : config.maxRounds,
          parallelUnits:
            body.parallelUnits !== undefined ? Boolean(body.parallelUnits) : (config.threads.parallelUnits ?? true),
        });
        sendJson(res, 200, { job: job.state });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/jobs/stop") {
        const body = await readBody(req);
        const job = manager.get(String(body.jobId ?? ""));
        if (job) job.stop();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/jobs/review") {
        const body = await readBody(req);
        const job = manager.get(String(body.jobId ?? ""));
        if (!job) {
          sendJson(res, 404, { error: "진행 중인 작업이 없습니다." });
          return;
        }
        const err = job.review(body.decision === "rework" ? "rework" : "accept", String(body.note ?? ""));
        if (err) {
          sendJson(res, 400, { error: err });
          return;
        }
        sendJson(res, 200, { ok: true, state: job.state });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/jobs/feedback") {
        const body = await readBody(req);
        const jobId = String(body.jobId ?? "").trim();
        const verdict = String(body.verdict ?? "").trim() as HumanVerdict;
        const note = String(body.note ?? "");
        if (!jobId) {
          sendJson(res, 400, { error: "작업 ID(jobId)가 필요합니다." });
          return;
        }
        if (verdict !== "correct" && verdict !== "partial" && verdict !== "incorrect") {
          sendJson(res, 400, { error: "판정(verdict)은 correct, partial, incorrect 중 하나여야 합니다." });
          return;
        }
        try {
          const record = applyFeedback(config.dataDir, jobId, verdict, note);
          sendJson(res, 200, { ok: true, record });
        } catch (err) {
          sendJson(res, 404, { error: (err as Error).message });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cleanup") {
        const report = purgeAllCompletedLogs(config, manager.getActiveJobIds());
        manager.evictDeletedJobs();
        sendJson(res, 200, { report, storage: getStorageStats(config.dataDir) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/finetune/config") {
        const body = await readBody(req);
        const patch: Record<string, any> = {};
        if (body.enabled !== undefined) patch.curateLogs = Boolean(body.enabled);
        if (body.targetMB !== undefined && Number(body.targetMB) > 0) {
          patch.maxFinetuneSizeMB = Number(body.targetMB);
        }
        const next = updateAndSaveConfig(patch);
        sendJson(res, 200, {
          ok: true,
          enabled: next.curateLogs,
          targetMB: next.retention.maxFinetuneSizeMB,
          finetune: getFinetuneSummary(next.dataDir),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/finetune/export") {
        const format = url.searchParams.get("format") === "jsonl" ? "jsonl" : "json";
        const onlyGood = url.searchParams.get("onlyGood") === "1" || url.searchParams.get("onlyGood") === "true";
        const role = url.searchParams.get("role") || "all";
        const exported = exportFinetuneDataset(config.dataDir, { format, onlyGood, role });
        res.writeHead(200, {
          "Content-Type": exported.contentType,
          "Content-Disposition": `attachment; filename="${exported.filename}"`,
          "Cache-Control": "no-store",
        });
        res.end(exported.content);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/finetune/reset") {
        const result = resetFinetuneDirectory(config.dataDir);
        sendJson(res, 200, {
          ok: true,
          freedBytes: result.freedBytes,
          finetune: getFinetuneSummary(config.dataDir),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/soul-catalog") {
        sendJson(res, 200, readSoulAndCatalog());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/ui/control") {
        const body = await readBody(req);
        if (body.action === "apply_preset" && body.preset) {
          const patch = resolveCatalogPreset(String(body.preset));
          if (!patch) {
            sendJson(res, 400, { error: `Unknown preset: ${body.preset}` });
            return;
          }
          const next = updateAndSaveConfig(patch);
          publishUiAction({
            uiAction: "set_form",
            maxUnits: next.threads.maxUnits,
            parallelUnits: next.threads.parallelUnits,
            mode: next.threads.defaultMode,
          });
          sendJson(res, 200, { ok: true, config: next });
          return;
        }
        publishUiAction({
          uiAction: body.action || "refresh",
          workspace: body.workspace,
          request: body.request,
          mode: body.mode,
          maxUnits: body.maxUnits,
          parallelUnits: body.parallelUnits,
          maxRounds: body.maxRounds,
          jobId: body.jobId,
          filter: body.filter,
          search: body.search,
          unitId: body.unitId,
          open: body.open,
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/shutdown") {
        sendJson(res, 200, { ok: true });
        setTimeout(() => {
          server.close(() => process.exit(0));
          setTimeout(() => process.exit(0), 200).unref();
        }, 120);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/settings") {
        const body = await readBody(req);
        updateAndSaveConfig(body);
        publishUiAction({
          uiAction: "set_form",
          maxUnits: config.threads.maxUnits,
          parallelUnits: config.threads.parallelUnits,
          mode: config.threads.defaultMode,
        });
        sendJson(res, 200, { ok: true, uiHost: config.uiHost, uiPort: config.uiPort });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  const desiredHost = String(process.env.HERDR_CKD_HOST ?? config.uiHost ?? "127.0.0.1").trim() || "127.0.0.1";
  const desiredPort = Number(process.env.HERDR_CKD_PORT ?? config.uiPort ?? 37501);
  const actualPort = await listenWithFallback(server, desiredPort, desiredHost);
  server.on("close", () => {
    liveBus.off("thread_event", onLive);
    liveBus.off("ui_action", onUiAction);
  });
  return { server, port: actualPort, host: desiredHost };
}

// 원본 Herdr의 Detach & Reattach 방식:
// 창을 닫아도(Detach) 백그라운드 세션은 살아 있으므로, 다시 실행 시 이미 돌고 있는 세션이 있으면 중복 서버를 띄우지 않고 즉시 재접속(Reattach)한다.
async function tryReattachExistingSession(): Promise<string | null> {
  try {
    ensureDesktopDataDir();
    const cfg = loadConfig();
    const rawHost = String(process.env.HERDR_CKD_HOST ?? cfg.uiHost ?? "127.0.0.1").trim() || "127.0.0.1";
    const displayHost = rawHost === "0.0.0.0" ? "127.0.0.1" : rawHost;
    const port = Number(process.env.HERDR_CKD_PORT ?? cfg.uiPort ?? 37501);
    if (!port || port <= 0) return null;
    const url = `http://${displayHost}:${port}`;
    const res = await fetch(`${url}/api/overview`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, any>;
    if (data && data.config && data.storage && Array.isArray(data.jobs)) {
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

// 직접 실행 시 서버 가동 후 데스크톱 앱 창 오픈 (--verify-only 시 검증 출력 후 즉시 종료)
const isVerifyOnly = process.argv.includes("--verify-only") || process.env.HERDR_VERIFY_ONLY === "1";
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isMain =
  entryPath.endsWith("ui-server.js") ||
  entryPath.endsWith("ui-server.ts") ||
  path.basename(entryPath, path.extname(entryPath)) === "herdr-ckd";

if (isMain) {
  (async () => {
    if (!isVerifyOnly) {
      const existingUrl = await tryReattachExistingSession();
      if (existingUrl) {
        console.log(`[Herdr CKD] 기존 백그라운드 세션 감지됨 — 즉시 재접속(Reattach): ${existingUrl}`);
        openNativeWindow(existingUrl);
        process.exit(0);
      }
    }

    const { server, port, host } = await startUiServer();
    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const url = `http://${displayHost}:${port}`;
    if (isVerifyOnly) {
      console.log(`[Herdr CKD] VERIFY_OK ${url} (MCP: ${url}/mcp)`);
      setTimeout(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 100).unref();
      }, 300);
      return;
    }
    console.log(`[Herdr CKD] 스레드 분리 데스크톱 대시보드 실행됨: ${url}`);
    console.log(`[Herdr CKD] IDE 제어용 Streamable HTTP MCP 엔드포인트: ${url}/mcp (바인딩: ${host}:${port})`);
    openNativeWindow(url);
  })().catch((err) => {
    console.error(`[Herdr CKD] UI 서버 시작 실패: ${(err as Error).message}`);
    process.exit(1);
  });
}
