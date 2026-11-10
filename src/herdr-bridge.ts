// Herdr 터미널 런타임(OSC 7501 Rev 0.4 Program Status Protocol + herdr/hc CLI) 및 내장 스레드 분리 UI 실시간 브릿지
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { CkdConfig } from "./config.js";

export type HerdrAgentState = "working" | "blocked" | "idle" | "done" | "error" | "clear";

export interface ThreadLiveEvent {
  jobId: string;
  unitId: string; // "C" 또는 "unit-1", "unit-2"...
  actor: string; // "C" | "A1" | "B1" | "A2" | "B2"...
  state: HerdrAgentState;
  phase: string;
  round?: number;
  message?: string;
  diffFiles?: string[];
  prUrl?: string;
  timestamp: string;
}

export interface UiRemoteActionEvent {
  uiAction:
    | "set_form"
    | "select_job"
    | "set_filter"
    | "set_search"
    | "zoom_unit"
    | "toggle_diff"
    | "open_settings"
    | "close_settings"
    | "check_models"
    | "refresh";
  workspace?: string;
  request?: string;
  mode?: string;
  maxUnits?: number;
  parallelUnits?: boolean;
  maxRounds?: number;
  jobId?: string;
  filter?: "all" | "working" | "checking" | "blocked" | "done";
  search?: string;
  unitId?: string;
  open?: boolean;
  timestamp?: string;
}

export const liveBus = new EventEmitter();
liveBus.setMaxListeners(100);

export function publishUiAction(ev: UiRemoteActionEvent): void {
  liveBus.emit("ui_action", {
    ...ev,
    timestamp: new Date().toISOString(),
  });
}

// OSC 7501 Program Status Protocol (Rev 0.4) 공식 포맷 생성기
// 규격: ESC ] 7501 ; state=<state>:app=<app>:id=<subtaskId>:msg=<base64> BEL
export function formatOsc7501(
  state: HerdrAgentState,
  agentOrSubtaskId: string,
  summary = "",
  kind?: "permission" | "question" | "auth",
): string {
  // "herdr-ckd:unit-1/A1" 또는 "herdr-ckd:C1" 형태가 들어오면 app과 subtask id를 정규화한다.
  let rawId = agentOrSubtaskId.trim();
  if (rawId.startsWith("herdr-ckd:")) {
    rawId = rawId.slice("herdr-ckd:".length);
  }
  const cleanId = rawId
    .replace(/[^A-Za-z0-9_./+-]/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "")
    .slice(0, 128);

  const parts: string[] = [`state=${state}`, "app=herdr-ckd"];
  if (cleanId) {
    parts.push(`id=${cleanId}`);
  }
  if (state === "blocked" && kind) {
    parts.push(`kind=${kind}`);
  }
  const cleanSummary = summary.replace(/[\r\n]/g, " ").trim().slice(0, 512);
  if (cleanSummary && state !== "clear") {
    const b64Msg = Buffer.from(cleanSummary, "utf8").toString("base64");
    parts.push(`msg=${b64Msg}`);
  }
  return `\x1b]7501;${parts.join(":")}\x07`;
}

// OSC 7501 Program Status Protocol 출력:
// Herdr(Rust)나 Ghostty 등 호환 터미널에서 에이전트별 상태(working, blocked, idle, done, error)를 즉시 인식시킨다.
export function emitOsc7501(
  state: HerdrAgentState,
  agentName: string,
  summary = "",
  stream: { isTTY?: boolean; write: (chunk: string) => unknown } = process.stdout,
  force = false,
): string {
  const seq = formatOsc7501(state, agentName, summary);
  if (stream.isTTY || force || process.env.HERDR_FORCE_OSC7501 === "1") {
    stream.write(seq);
  }
  return seq;
}

export function isHerdrCliAvailable(): boolean {
  for (const bin of ["herdr", "hc"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 3000 });
      return true;
    } catch {
      // 다음 후보 확인
    }
  }
  return false;
}

export function spawnHerdrUnitPane(config: CkdConfig, unitId: string, title: string, cwd: string): boolean {
  if (!config.herdr.enabled || !config.herdr.autoSpawnPanes || !isHerdrCliAvailable()) {
    return false;
  }
  const safeName = `ckd-${unitId}`.replace(/[^A-Za-z0-9_-]/g, "-");
  // 1순위: 현재 활성 Herdr 세션 내부라면 `herdr pane split`으로 우측 분할 패인 생성
  try {
    execFileSync("herdr", ["pane", "split", "--current", "--direction", "right"], {
      cwd,
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    // 2순위: `hc run --bg --name <name>` 백그라운드 지속 터미널 생성 (원본 Herdr 공식 CLI 규격)
    try {
      const shellCmd = process.platform === "win32" ? "cmd" : process.env.SHELL || "sh";
      execFileSync("hc", ["run", "--bg", "--name", safeName, shellCmd], {
        cwd,
        stdio: "ignore",
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function publishThreadEvent(config: CkdConfig, ev: Omit<ThreadLiveEvent, "timestamp">): void {
  const full: ThreadLiveEvent = {
    ...ev,
    timestamp: new Date().toISOString(),
  };
  liveBus.emit("thread_event", full);

  if (config.herdr.enabled && config.herdr.emitOsc7501) {
    const subtaskId = full.unitId && full.unitId !== full.actor ? `${full.unitId}/${full.actor}` : full.actor;
    emitOsc7501(full.state, subtaskId, full.phase);
  }
}

// Herdr 플러그인 매니페스트(herdr-plugin.toml) 생성기
export function generateHerdrPluginManifest(): string {
  return `# Herdr CKD 공식 연동 플러그인 설정 (Created by AXNli Inc.)
name = "herdr-ckd"
version = "0.2.0"
description = "Herdr CKD: 중심 코어 C(1개) + 다중 [A_n·B_n] 스레드 협업 런타임 및 대시보드"

[agent]
id = "herdr-ckd"
protocol = "osc7501"
roles = ["C (Leader)", "A1..An (Maker)", "B1..Bn (Checker)"]

[commands.ui]
description = "Herdr CKD 스레드 분리 대시보드 실행 (또는 기존 세션 재접속)"
run = "node dist/src/ui-server.js"
`;
}
