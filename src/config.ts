// 설정 불러오기. 모든 기록은 dataDir(외장 SSD 권장) 아래에만 저장한다.
import fs from "node:fs";
import path from "node:path";

export type Role = "A" | "B" | "C";

// Herdr CKD 확정 역할 명칭:
// C = 중심 코어 (1개 고정 - 지휘·분할·중개·최종판정 / Coordinator · Relay · Final Judge)
// A = 스레드별 실행·구현자 (A1, A2, A3... / Maker)
// B = 스레드별 전담 검수자 (B1, B2, B3... / Checker)
export const ROLE_NAMES: Record<Role, string> = {
  A: "Maker",
  B: "Checker",
  C: "Leader",
};

// OpenAI 호환 API를 제공하는 로컬/내부망 서버 및 유료 클라우드 서버의 기본 주소
export const BACKEND_DEFAULT_URLS: Record<string, string> = {
  lmstudio: "http://localhost:1234/v1",
  ollama: "http://localhost:11434/v1",
  mlx: "http://localhost:8080/v1",
  llamacpp: "http://localhost:8080/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
};

export interface ModelConfig {
  backend: string; // lmstudio | ollama | mlx | llamacpp | openai | gemini | openrouter | deepseek | custom
  baseUrl?: string; // 내부망 원격 서버 연결 시 예: http://192.168.0.10:1234/v1 또는 유료 API 엔드포인트
  model: string;
  apiKey?: string;
  temperature?: number;
  reasoningEffort?: string; // 추론 사고 깊이 (low | medium | high)
  contextTokens?: number; // 이 값의 60%를 넘으면 새 세션으로 인계
  vision?: boolean; // false면 이 역할에게 이미지를 붙이지 않고 경로와 설명만 준다 (이미지를 못 읽는 모델)
  timeoutMs?: number;
  upstreamUrl?: string; // Headroom 사용 시 원래 모델 서버 주소 (기록용)
}

export type ThreadExecutionMode = "auto" | "split" | "compete";
export type GithubSyncMode = "off" | "push_on_complete" | "pr_on_review";

export interface ThreadConfig {
  maxUnits: number; // 동시 실행 가능한 [A_n + B_n] 스레드 유닛 최대 수 (기본 3, 저사양 GPU는 1 권장)
  defaultMode: ThreadExecutionMode; // auto(C가 판단) | split(분업) | compete(경쟁)
  useWorktree: boolean; // 스레드 유닛별 Git Worktree 격리 사용 여부
  parallelUnits?: boolean; // true(기본)=동시 병렬 실행(고성능 맥/유료 API), false=순차 1유닛씩 실행(저사양 단일 GPU VRAM 보호)
}

export interface GithubSyncConfig {
  mode: GithubSyncMode; // off | push_on_complete | pr_on_review
  remote: string; // 기본 "origin"
  branchPrefix: string; // 기본 "ckd" -> ckd/<jobId>/unit-<N>
  deleteBranchOnComplete: boolean; // true면 작업/병합 완료 시 원격 임시 브랜치 즉시 자동 삭제
  maxRemoteBranches: number; // 원격에 남겨둘 최대 ckd/* 브랜치 수 (초과 시 오래된 순 자동 삭제)
}

export interface LogRetentionConfig {
  deleteTempOnComplete: boolean; // 작업 완료 즉시 original 사본 및 임시 worktree 삭제
  maxJobsToKeep: number; // jobs/<ID>/ 최대 보관 작업 개수 (기본 30, 초과 시 오래된 순 삭제)
  maxLogSizeMB: number; // jobs/ 폴더 최대 용량 MB (기본 500MB, 초과 시 오래된 순 삭제)
  maxFinetuneSizeMB: number; // finetune/ 폴더 최대 용량 MB (기본 200MB, 초과 시 오래된 순 삭제)
}

export interface HerdrIntegrationConfig {
  enabled: boolean; // Herdr 연동 활성화
  emitOsc7501: boolean; // 터미널 표준 OSC 7501 상태 신호 출력 (working | blocked | idle | done)
  autoSpawnPanes: boolean; // hc CLI가 있을 때 스레드 유닛별 패인 자동 생성
}

export interface CkdConfig {
  dataDir: string;
  defaultWorkspace?: string;
  customRules?: string; // 사용자가 직접 입력한 커스텀 작업/코딩 규칙 (C, A_n, B_n 프롬프트에 자동 주입)
  readPaths: string[]; // 작업 폴더 밖이지만 읽을 수 있는 폴더
  originalCopy?: string; // 작업 시작 때 작업 폴더의 사본
  model: ModelConfig;
  roleModels: Partial<Record<Role, Partial<ModelConfig>>>;
  maxRounds: number; // 0이면 제한 없음
  pingPongLimit: number;
  fixStreakLimit: number; // B의 NEEDS_FIX가 이만큼 이어지면 중심 코어가 원인을 진단한다
  curateLogs: boolean; // 작업이 끝나면 기록을 정리해 finetune/curated.jsonl에 남긴다
  requireReview: boolean; // true면 연결된 AI(MCP를 부른 쪽)가 ckd_review로 확인해야 completed
  attachments: { maxImages: number; maxImageMB: number; pdfPages: number };
  handoffRatio: number;
  maxToolSteps: number;
  maxToolOutputChars: number;
  commandTimeoutMs: number;
  threads: ThreadConfig;
  github: GithubSyncConfig;
  retention: LogRetentionConfig;
  herdr: HerdrIntegrationConfig;
  uiHost: string;
  uiPort: number;
  tools: {
    rtk: boolean;
    ponytail: boolean;
    ponytailRulesFile?: string;
    serena: boolean;
    serenaCommand: string;
    serenaArgs: string[];
    headroom: boolean;
    headroomUrl: string;
    web: boolean;
    ddgsCommand: string[];
    browser: boolean;
    browserChannel: string;
    vision: boolean;
  };
}

const DEFAULTS: Omit<CkdConfig, "dataDir"> = {
  model: {
    backend: "lmstudio",
    model: "local-model",
    temperature: 0.6,
    contextTokens: 262144,
    timeoutMs: 600000,
  },
  customRules: "",
  roleModels: {},
  readPaths: [],
  maxRounds: 0,
  pingPongLimit: 3,
  fixStreakLimit: 3,
  curateLogs: true,
  requireReview: true,
  attachments: { maxImages: 6, maxImageMB: 5, pdfPages: 3 },
  handoffRatio: 0.6,
  maxToolSteps: 40,
  maxToolOutputChars: 12000,
  commandTimeoutMs: 300000,
  threads: {
    maxUnits: 6,
    defaultMode: "auto",
    useWorktree: true,
    parallelUnits: true,
  },
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
  uiHost: "127.0.0.1",
  uiPort: 37501,
  tools: {
    rtk: false,
    ponytail: false,
    serena: false,
    serenaCommand: "uvx",
    serenaArgs: ["--from", "serena-agent", "serena", "start-mcp-server"],
    headroom: false,
    headroomUrl: "http://localhost:8787/v1",
    web: true,
    ddgsCommand: ["uv", "run", "--no-project", "--with", "ddgs", "python"],
    browser: true,
    browserChannel: "chrome",
    vision: true,
  },
};

export class ConfigError extends Error {}

// 설정 파일 위치: CKD_CONFIG 또는 CKD_DATA_DIR/ckd.config.json
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CkdConfig {
  const dataDirEnv = env.CKD_DATA_DIR;
  const configPath =
    env.CKD_CONFIG ?? (dataDirEnv ? path.join(dataDirEnv, "ckd.config.json") : undefined);
  if (!configPath) {
    throw new ConfigError("CKD_DATA_DIR 또는 CKD_CONFIG 환경변수를 지정해 주세요.");
  }

  let fileConfig: Partial<CkdConfig> = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } else if (env.CKD_CONFIG) {
    throw new ConfigError(`설정 파일이 없습니다: ${configPath}`);
  }

  const dataDir = dataDirEnv ?? fileConfig.dataDir;
  if (!dataDir) throw new ConfigError("dataDir가 설정되지 않았습니다.");

  // 외장 SSD가 빠져 있으면 내장 디스크에 몰래 만들지 않고 멈춘다.
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new ConfigError(
      `데이터 폴더가 없습니다: ${dataDir}. 외장 SSD가 연결되어 있는지 확인해 주세요.`,
    );
  }

  const config: CkdConfig = {
    ...DEFAULTS,
    ...fileConfig,
    dataDir,
    model: { ...DEFAULTS.model, ...fileConfig.model },
    roleModels: { ...fileConfig.roleModels },
    threads: { ...DEFAULTS.threads, ...fileConfig.threads },
    github: { ...DEFAULTS.github, ...fileConfig.github },
    retention: { ...DEFAULTS.retention, ...fileConfig.retention },
    herdr: { ...DEFAULTS.herdr, ...fileConfig.herdr },
    tools: { ...DEFAULTS.tools, ...fileConfig.tools },
    attachments: { ...DEFAULTS.attachments, ...fileConfig.attachments },
  };
  return config;
}

export function saveConfigFile(config: CkdConfig): void {
  const configPath = path.join(config.dataDir, "ckd.config.json");
  const { dataDir: _d, originalCopy: _o, ...toSave } = config;
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), "utf8");
}

export function modelFor(config: CkdConfig, role: Role): ModelConfig {
  const merged = { ...config.model, ...config.roleModels[role] } as ModelConfig;
  if (!merged.baseUrl) {
    const url = BACKEND_DEFAULT_URLS[merged.backend];
    if (!url) throw new ConfigError(`${role}의 baseUrl이 필요합니다 (backend: ${merged.backend}).`);
    merged.baseUrl = url;
  }
  // Headroom 프록시가 압축한 뒤 원래 모델 서버로 넘긴다. 기록에는 압축 전 원문이 남는다.
  if (config.tools.headroom) {
    merged.upstreamUrl = merged.baseUrl;
    merged.baseUrl = config.tools.headroomUrl;
  }
  return merged;
}
