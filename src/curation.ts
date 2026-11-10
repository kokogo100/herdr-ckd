// 작업 기록 정리 결과(jobs/<ID>/curation.json)와 사람 판정.
// C의 판단은 suggested_label(제안)일 뿐이고, 학습용 표시(training_label)는 사람 판정이 붙어야 정해진다.
// correct → good, partial → partial, incorrect → bad. 모든 정리 결과는 finetune/curated.jsonl로 다시 모은다.
import fs from "node:fs";
import path from "node:path";

export type HumanVerdict = "correct" | "partial" | "incorrect";

const LABEL: Record<HumanVerdict, string> = { correct: "good", partial: "partial", incorrect: "bad" };

export function curationFile(dataDir: string, jobId: string): string {
  return path.join(dataDir, "jobs", jobId, "curation.json");
}

export function applyFeedback(dataDir: string, jobId: string, verdict: HumanVerdict, note = ""): Record<string, unknown> {
  if (!(verdict in LABEL)) throw new Error(`판정은 correct, partial, incorrect 중 하나여야 합니다: ${verdict}`);
  const jobDir = path.join(dataDir, "jobs", jobId);
  const at = new Date().toISOString();

  if (fs.existsSync(jobDir)) {
    const file = curationFile(dataDir, jobId);
    const record: Record<string, unknown> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { job_id: jobId };
    // 메모는 덮어쓰지 않고 쌓는다 (검증한 사람의 메모와 사용자의 말이 모두 남게).
    record.feedback_history = [...(Array.isArray(record.feedback_history) ? record.feedback_history : []), { verdict, note, at }];
    record.human_verdict = { verdict, note, at };
    record.training_label = LABEL[verdict];
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    rebuildCurated(dataDir);
    return record;
  }

  // jobs/<jobId> 폴더가 로그 순환 정리에 의해 이미 삭제된 경우 finetune/curated.jsonl에서 직접 찾아 갱신한다.
  const curatedPath = path.join(dataDir, "finetune", "curated.jsonl");
  if (fs.existsSync(curatedPath)) {
    const rawLines = fs.readFileSync(curatedPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    let foundRecord: Record<string, unknown> | undefined;
    const updatedLines = rawLines.map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.job_id === jobId) {
          parsed.feedback_history = [...(Array.isArray(parsed.feedback_history) ? parsed.feedback_history : []), { verdict, note, at }];
          parsed.human_verdict = { verdict, note, at };
          parsed.training_label = LABEL[verdict];
          foundRecord = parsed;
          return JSON.stringify(parsed);
        }
      } catch {
        // ignore malformed line
      }
      return line;
    });
    if (foundRecord) {
      fs.writeFileSync(curatedPath, updatedLines.join("\n") + "\n", "utf8");
      rebuildCurated(dataDir);
      return foundRecord;
    }
  }

  throw new Error(`작업이 없습니다: ${jobId}`);
}

// 기존 finetune/curated.jsonl의 항목을 보존하면서 jobs/*/curation.json을 병합해 다시 쓴다 (로그 삭제 후에도 정제 데이터 유지).
export function rebuildCurated(dataDir: string): number {
  const finetuneDir = path.join(dataDir, "finetune");
  const curatedPath = path.join(finetuneDir, "curated.jsonl");
  const merged = new Map<string, Record<string, unknown>>();

  if (fs.existsSync(curatedPath)) {
    const existingLines = fs.readFileSync(curatedPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    for (const line of existingLines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const id = typeof parsed.job_id === "string" ? parsed.job_id : undefined;
        if (id) merged.set(id, parsed);
      } catch {
        // ignore malformed line
      }
    }
  }

  const jobsDir = path.join(dataDir, "jobs");
  const jobIds = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).sort() : [];
  for (const id of jobIds) {
    const f = curationFile(dataDir, id);
    if (!fs.existsSync(f)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
      const key = typeof parsed.job_id === "string" ? parsed.job_id : id;
      merged.set(key, parsed);
    } catch {
      // ignore malformed file
    }
  }

  const lines = [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rec]) => JSON.stringify(rec));
  fs.mkdirSync(finetuneDir, { recursive: true });
  fs.writeFileSync(curatedPath, lines.length ? lines.join("\n") + "\n" : "", "utf8");
  return lines.length;
}
