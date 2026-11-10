// 작업 기록(events.jsonl, sessions)을 규칙으로 집계한다. C가 기록을 정리하기 전에 "기계가 센 사실"을 먼저 받게 한다.
// 문제 분류는 trace2train(github wane528/trace2train, MIT)의 inspect 범주를 참고했다:
// 잘못된 도구, 잘못된 인자, 맥락 잃음(같은 자리 맴돌기), 출력 형식 오류, 중복 호출, 개인정보.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface Line {
  [key: string]: any;
}

function readJsonl(file: string): Line[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const PERSONAL_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|01[016789]-?\d{3,4}-?\d{4})/;

export interface JobFacts {
  job_id: string;
  request?: string;
  status?: string;
  rounds?: number;
  error?: string;
  elapsed_s?: number; // 시작부터 끝까지 걸린 초
  max_rounds?: number; // 이 작업의 회차 한도 (0이면 제한 없음)
  judges: { round: number; verdict: string }[];
  relays: { round: number; from: string; status?: string }[];
  events: Record<string, number>;
  tool_calls: Record<string, Record<string, number>>; // 세션별 도구별 호출 수
  used_browser_check: boolean;
  used_view_image: boolean;
  failed_commands: string[];
  issues: {
    wrong_tool: number; // 없는 도구, 허용되지 않은 도구
    bad_args: number; // 필수 인자 누락, JSON 오류, 모르는 동작, 수정 대상 없음, 작업 폴더 밖 경로
    lost_context: number; // 같은 수정 요청 반복 진단, 도구 한도
    format_error: number;
    duplicate_calls: number; // 같은 호출 반복 차단 + 같은 인자로 같은 도구를 3번 이상
    privacy: number; // 키나 개인정보로 보이는 문자열
  };
  repeated_edits: number; // 같은 파일에 같은 수정을 다시 한 횟수
  trace2train?: unknown;
}

export function inspectJob(jobDir: string): JobFacts {
  const state: Line = fs.existsSync(path.join(jobDir, "state.json")) ? JSON.parse(fs.readFileSync(path.join(jobDir, "state.json"), "utf8")) : {};
  const events = readJsonl(path.join(jobDir, "events.jsonl"));
  const facts: JobFacts = {
    job_id: path.basename(jobDir),
    request: state.request,
    status: state.status,
    rounds: state.round,
    error: state.error,
    max_rounds: state.maxRounds,
    elapsed_s: state.startedAt && state.finishedAt ? Math.round((Date.parse(state.finishedAt) - Date.parse(state.startedAt)) / 1000) : undefined,
    judges: [],
    relays: [],
    events: {},
    tool_calls: {},
    used_browser_check: false,
    used_view_image: false,
    failed_commands: [],
    issues: { wrong_tool: 0, bad_args: 0, lost_context: 0, format_error: 0, duplicate_calls: 0, privacy: 0 },
    repeated_edits: 0,
  };
  for (const e of events) {
    facts.events[e.type] = (facts.events[e.type] ?? 0) + 1;
    if (e.type === "judge") facts.judges.push({ round: e.round, verdict: String(e.verdict) });
    if (e.type === "relay") facts.relays.push({ round: e.round, from: e.from, status: e.status?.status });
    if (e.type === "tool_call") {
      const s = (facts.tool_calls[e.session] ??= {});
      s[e.tool] = (s[e.tool] ?? 0) + 1;
      if (e.tool === "browser_check") facts.used_browser_check = true;
      if (e.tool === "view_image") facts.used_view_image = true;
    }
  }
  facts.issues.format_error = facts.events.format_error ?? 0;
  facts.issues.lost_context = (facts.events.fix_streak_diagnosis ?? 0) + (facts.events.tool_limit ?? 0);

  const sessionsDir = path.join(jobDir, "sessions");
  const sessionFiles = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")) : [];
  for (const f of sessionFiles) {
    const lines = readJsonl(path.join(sessionsDir, f));
    const calls = new Map<string, { name: string; args: string }>();
    const seen = new Map<string, number>();
    for (const l of lines) {
      const m = l.message ?? {};
      for (const c of m.tool_calls ?? []) {
        calls.set(c.id, { name: c.function?.name, args: c.function?.arguments });
        const key = `${c.function?.name}\u0000${c.function?.arguments}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      if (SECRET_RE.test(text) || PERSONAL_RE.test(text)) facts.issues.privacy++;
      if (m.role !== "tool") continue;
      const out = String(m.content ?? "");
      const call = calls.get(m.tool_call_id);
      if (/^알 수 없거나 .*허용되지 않은 도구/.test(out)) facts.issues.wrong_tool++;
      if (/도구 실행 안 함: .*필수 인자|도구 인수가 올바른 JSON이 아닙니다|알 수 없는 동작입니다|수정 실패: old_text가|작업 폴더 밖의 경로/.test(out)) facts.issues.bad_args++;
      if (out.startsWith("같은 도구 호출을 같은 인자로")) facts.issues.duplicate_calls++;
      if (call?.name === "run_command" && !out.startsWith("종료 코드 0\n") && !out.startsWith("같은 도구 호출")) {
        let cmd = call.args;
        try {
          cmd = JSON.parse(call.args).command ?? cmd;
        } catch {
          // 원문 그대로
        }
        facts.failed_commands.push(`${f.replace(".jsonl", "")}: ${String(cmd).slice(0, 160)} → ${out.split("\n").slice(0, 2).join(" / ").slice(0, 160)}`);
      }
    }
    for (const [key, n] of seen) {
      if (n >= 3) facts.issues.duplicate_calls += n - 2;
      if (n >= 2 && /^(edit_file|write_file)\u0000/.test(key)) facts.repeated_edits += n - 1;
    }
  }
  facts.failed_commands = facts.failed_commands.slice(0, 20);
  return facts;
}

// trace2train이 설치돼 있으면 그 inspect 결과도 붙인다. 없으면 건너뛴다(필수 아님).
export function trace2trainInspect(jobDir: string): unknown {
  const sessionsDir = path.join(jobDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return undefined;
  const tmp = path.join(jobDir, "trace2train-input.jsonl");
  const rows = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => JSON.stringify({ messages: readJsonl(path.join(sessionsDir, f)).map((l) => l.message) }));
  fs.writeFileSync(tmp, rows.join("\n") + "\n");
  const run = spawnSync("python", ["-X", "utf8", "-m", "trace2train", "inspect", "--format", "messages", "--json", tmp], { encoding: "utf8", timeout: 60000 });
  fs.rmSync(tmp, { force: true });
  if (run.status !== 0) return undefined;
  try {
    return JSON.parse(run.stdout);
  } catch {
    return run.stdout.slice(0, 2000);
  }
}

export function factsText(f: JobFacts): string {
  return JSON.stringify(f, null, 1);
}
