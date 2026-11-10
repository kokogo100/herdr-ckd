// 모든 과정을 원문 그대로 기록한다. 나중에 로컬/커스텀 모델 파인튜닝(SFT·DPO) 데이터로 쓰기 위함.
//
// <dataDir>/jobs/<jobId>/events.jsonl      모든 사건 (전달, 판정, 오류)
// <dataDir>/jobs/<jobId>/sessions/*.jsonl  역할별 세션 메시지 원문 (OpenAI 메시지 형식)
// <dataDir>/jobs/<jobId>/state.json        현재 상태
// <dataDir>/finetune/<A|B|C>.jsonl         작업이 끝나면 {"messages": [...], "meta": {...}} 한 줄씩 추가
import fs from "node:fs";
import path from "node:path";
import type { Role } from "./config.js";
import { forLog, type ChatMessage } from "./llm.js";

export class Recorder {
  readonly jobDir: string;

  constructor(
    readonly dataDir: string,
    readonly jobId: string,
  ) {
    this.jobDir = path.join(dataDir, "jobs", jobId);
    fs.mkdirSync(path.join(this.jobDir, "sessions"), { recursive: true });
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ time: new Date().toISOString(), type, ...data });
    fs.appendFileSync(path.join(this.jobDir, "events.jsonl"), line + "\n");
  }

  message(sessionId: string, msg: ChatMessage, meta: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ time: new Date().toISOString(), ...meta, message: forLog(msg) });
    fs.appendFileSync(path.join(this.jobDir, "sessions", `${sessionId}.jsonl`), line + "\n");
  }

  saveState(state: unknown): void {
    const file = path.join(this.jobDir, "state.json");
    const payload = JSON.stringify(state, null, 2);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload);
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.writeFileSync(file, payload);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore cleanup error
      }
    }
  }

  exportFinetune(role: Role, sessionId: string, messages: ChatMessage[], meta: Record<string, unknown>): void {
    const dir = path.join(this.dataDir, "finetune");
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ messages: messages.map(forLog), meta: { job_id: this.jobId, role, session_id: sessionId, ...meta } });
    fs.appendFileSync(path.join(dir, `${role}.jsonl`), line + "\n");
  }
}
