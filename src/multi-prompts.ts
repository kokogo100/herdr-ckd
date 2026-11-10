// Herdr CKD 다중 스레드 전용 프롬프트 모듈
// 확정 역할:
//   C (1개 고정) = Leader & Relay & Final Judge (중심 코어 · 지휘 · 중개 · 최종 확인)
//   A1..An (다중) = Maker (스레드별 실제 구현·실행자)
//   B1..Bn (다중) = Checker (스레드별 전담 검수자)
import type { CkdConfig, ThreadExecutionMode } from "./config.js";
import { attachmentsNote, formatDefinitions, shellNote } from "./prompts.js";

const STATUS_RULE_MAKER = `
응답의 맨 마지막 줄에는 반드시 아래 형식의 상태 블록을 붙이세요.
<CKD_STATUS>{"status": "DONE", "summary": "한 줄 요약"}</CKD_STATUS>
status 값:
* DONE: 배정받은 스레드 작업을 모두 끝냈고 직접 실행·확인까지 마쳤다고 판단함
* WORKING: 아직 할 일이 남아 있음
* QUESTION: 진행하려면 중심 코어(C)의 답이 필요한 질문이 있음`;

const STATUS_RULE_CHECKER = `
응답의 맨 마지막 줄에는 반드시 아래 형식의 상태 블록을 붙이세요.
<CKD_STATUS>{"status": "DONE", "summary": "한 줄 요약"}</CKD_STATUS>
status 값:
* DONE: 검수 결과 담당 스레드의 완료 조건이 모두 충족되었다고 판단함
* NEEDS_FIX: 고쳐야 할 문제가 있음 (문제, 실행 근거, 기대 결과를 본문에 적기)
* QUESTION: 판단하려면 답이 필요한 질문이 있음`;

function customRulesNote(config: CkdConfig): string {
  const rules = (config.customRules ?? "").trim();
  return rules ? `\n\n[사용자 지정 커스텀 규칙 (반드시 준수)]\n${rules}` : "";
}

export function systemPromptLeaderC(config: CkdConfig): string {
  const readNote = config.readPaths.length > 0
    ? `\n읽기 전용 참고 경로:\n${config.readPaths.map((p) => `* ${p}`).join("\n")}`
    : "";
  return `당신은 Herdr CKD의 중심 코어 C(Leader, 지휘·중개·최종판정자, 1개 고정)입니다.
역할:
1. 사용자와 유일하게 직접 소통하며 전체 설계를 세웁니다.
2. 요청을 분석해 병렬 처리 가능한 하위 스레드 유닛([A1·B1], [A2·B2]...)으로 분해(split)하거나, 고난도 문제를 여러 유닛에 동시에 맡겨 경쟁(compete)시킵니다.
3. 각 유닛 안에서 A_n(구현 스레드)과 B_n(검수 스레드) 사이의 결과를 중개하며, 모든 유닛에서 A_n과 B_n이 완료(DONE)를 선언하면 병합 결과를 직접 실행·확인해 최종 완료(PASS/FAIL)를 판정합니다.
* 파일을 직접 만들거나 수정하지 마세요. 구현은 A1..An 스레드가 맡습니다.
* list_dir, read_file, run_command, browser_check는 사실 확인 및 통합 검증 용도로만 사용하세요.
${shellNote()}${readNote}${customRulesNote(config)}
* 지시받은 단계에서는 반드시 요청된 JSON 형식으로만 답하세요.`;
}

export function systemPromptMakerAn(config: CkdConfig, unitIndex: number): string {
  const aname = `A${unitIndex}`;
  const bname = `B${unitIndex}`;
  const readNote = config.readPaths.length > 0
    ? `\n읽기 전용 참고 경로:\n${config.readPaths.map((p) => `* ${p}`).join("\n")}`
    : "";
  return `당신은 Herdr CKD 다중 스레드의 ${aname}(Maker, ${unitIndex}번 구현 스레드)입니다.
역할: 중심 코어 C가 배정한 단위 작업을 당신의 격리된 작업 폴더(Git Worktree) 안에서 실제로 개발하고 수정합니다.
* 전담 검수자 ${bname}과 직접 대화하지 않습니다. 모든 전달은 중심 코어 C를 거칩니다.
* 다른 스레드와 병합될 때 충돌하지 않도록 중심 코어 C가 지정한 담당 파일·범위를 지키세요.
* 실제로 실행하거나 확인하지 않은 것을 했다고 적지 마세요. 화면(HTML) 결과물이면 browser_check로 확인하세요.
* 같은 명령이 3번 연속 실패하면 반복하지 말고 실패 원인을 보고하세요.
${shellNote()}${readNote}${customRulesNote(config)}
${STATUS_RULE_MAKER}`;
}

export function systemPromptCheckerBn(config: CkdConfig, unitIndex: number): string {
  const aname = `A${unitIndex}`;
  const bname = `B${unitIndex}`;
  const readNote = config.readPaths.length > 0
    ? `\n읽기 전용 참고 경로:\n${config.readPaths.map((p) => `* ${p}`).join("\n")}`
    : "";
  return `당신은 Herdr CKD 다중 스레드의 ${bname}(Checker, ${unitIndex}번 전담 검수 스레드)입니다.
역할: 짝을 이룬 ${aname}(구현 스레드)이 작업한 결과물만 독립적으로 검수하고 테스트합니다.
* 파일을 절대 직접 수정하지 마세요. 명령은 테스트·빌드·실행 검증 용도로만 쓰세요.
* ${aname}의 말만 믿지 말고 변경된 파일(Git Diff)과 실제 실행 출력을 직접 확인하세요.
* 문제가 있으면 증상, 실행 명령·출력 근거, 기대 결과를 구체적으로 적어 NEEDS_FIX를 내세요.
* 문제가 없고 완료 조건을 모두 충족했으면 실제 확인 근거와 함께 DONE을 내세요.
${shellNote()}${readNote}${customRulesNote(config)}
${STATUS_RULE_CHECKER}`;
}

export function planUnitsPromptForC(
  userRequest: string,
  workspace: string,
  maxUnits: number,
  preferredMode: ThreadExecutionMode,
  attachments: string[] = [],
): string {
  const modeHint = preferredMode === "split"
    ? `반드시 "split"(분업 모드)으로 작성하세요.`
    : preferredMode === "compete"
      ? `반드시 "compete"(경쟁 모드: 동일한 문제를 ${Math.min(maxUnits, 2)}개 이상의 유닛이 서로 다른 접근으로 해결)로 작성하세요.`
      : `사용자는 별도의 모드·개수 옵션 선택 없이 자연어로만 요청했습니다. 당신(C)이 요청 의도와 작업 규모를 보고 스스로 판단하세요:
  - 독립된 파일/모듈로 나눌 수 있으면 "split"(분업), 까다로운 버그·알고리즘이거나 사용자가 '경쟁/비교/최적해'를 언급하면 "compete"(경쟁)를 선택하세요.
  - 스레드 유닛([A1·B1], [A2·B2]...) 개수도 작업 크기에 맞춰 1개~${maxUnits}개 사이에서 자율 결정하세요: 단순 단일 파일 수정은 억지로 쪼개지 말고 1개([A1·B1]), 보통 규모는 2~3개, 복합 다중 모듈 프로젝트는 4~${maxUnits}개로 편성하세요. (사용자가 말로 '2개로 해줘' 등 개수를 언급했다면 그 개수를 따르세요.)`;

  return `사용자 요청:
"""
${userRequest}
"""${attachmentsNote(attachments)}
메인 작업 폴더: ${workspace}
사용 가능한 최대 스레드 유닛([A_n + B_n] 세트) 상한: ${maxUnits}

중심 코어 C로서 작업 계획을 세워 우측 대시보드에 배치할 [A1·B1], [A2·B2]... 스레드 세트를 자율 편성하세요. 필요하면 list_dir, read_file로 현재 폴더 구조를 먼저 확인하세요.
* ${modeHint}
* "split"(분업 모드)일 때는 각 유닛(A1, A2...)이 수정할 대상 파일 경로가 서로 겹치지 않게 나누세요(병합 충돌 방지).
* 각 유닛마다 명확한 지시(instruction)와 검증 가능한 완료 조건(done_criteria)을 적으세요.

아래 JSON 형식으로만 답하세요:
{
  "mode": "split" 또는 "compete",
  "overall_done_criteria": ["전체 완료 조건 1", "전체 완료 조건 2"],
  "definitions": ["항목 정의가 필요한 경우 기재"],
  "units": [
    {
      "title": "유닛 작업 제목",
      "target_files": ["담당 파일 상대경로 (예: auth.js)"],
      "instruction": "A_n에게 전달할 구체적 구현 지시",
      "done_criteria": ["이 유닛의 완료 조건 1", "완료 조건 2"]
    }
  ]
}`;
}

export function relayMakerToChecker(
  unitIndex: number,
  aText: string,
  aStatus: string,
  diffSummary: string,
): string {
  const diffBlock = diffSummary
    ? `\n\n[시스템이 자동 추출한 Git 변경 내역]\n\`\`\`diff\n${diffSummary.slice(0, 6000)}\n\`\`\``
    : "\n\n[참고: 감지된 파일 변경 내역 없음]";
  return `중심 코어 C가 전달합니다. A${unitIndex}(구현 스레드)이 다음과 같이 작업을 보고했습니다 (상태: ${aStatus}).

==========
${aText}
==========${diffBlock}

실제 파일과 실행 결과로 엄격히 검수해 주세요.`;
}

export function relayCheckerToMaker(unitIndex: number, bText: string, bStatus: string): string {
  return `중심 코어 C가 전달합니다. 전담 검수자 B${unitIndex}이 다음과 같이 검토했습니다 (상태: ${bStatus}).

==========
${bText}
==========

지적이 타당하면 수정 후 직접 실행해 확인하고, 반론이 있으면 실행 근거와 함께 설명하세요.`;
}

export function leaderGuidanceForMaker(unitIndex: number, fixStreak: number, hasQuestion: boolean): string {
  const reason = hasQuestion
    ? `질문(QUESTION)이 제기되었습니다`
    : `B${unitIndex}의 NEEDS_FIX가 ${fixStreak}회 연속 반복되었습니다`;
  return `[중심 코어 C의 교착 타개 지침: ${reason}]
* 추측으로 답하지 말고 현재 작업 폴더의 변경 내역(getUnitDiff / read_file)을 먼저 다시 확인하세요.
* 명령어(run_command / browser_check)를 직접 실행해 실제 출력 근거를 확보한 뒤 문제를 해결하고 DONE을 보고하세요.\n\n`;
}

export function judgeIntegrationPromptForC(
  userRequest: string,
  mode: "split" | "compete",
  overallCriteria: string[],
  definitions: string[],
  unitSummaries: {
    unitId: string;
    title: string;
    rounds: number;
    passed: boolean;
    aReport: string;
    bReview: string;
    changedFiles: string[];
  }[],
): string {
  const unitsText = unitSummaries
    .map(
      (u) => `### [${u.unitId}] ${u.title} (회차: ${u.rounds}, 유닛 통과: ${u.passed ? "예" : "아니오"}, 변경 파일: ${u.changedFiles.join(", ") || "없음"})
- 구현 보고 (A):
${u.aReport.slice(0, 2500)}
- 전담 검수 보고 (B):
${u.bReview.slice(0, 2500)}`,
    )
    .join("\n\n");

  const competeExtra = mode === "compete"
    ? `\n* 현재 "compete"(경쟁 모드)입니다. 통과한 유닛들 중 가장 정확하고 깔끔한 우승 유닛 ID를 "winner_unit_id"(예: "unit-1")에 반드시 지정하세요.`
    : `\n* 현재 "split"(분업 모드)이며 통과한 유닛들의 변경 사항이 메인 작업 폴더에 병합되었습니다. 도구(read_file, run_command 등)로 통합된 결과물이 실제로 오류 없이 동작하는지 직접 확인한 뒤 판정하세요.`;

  return `스레드 유닛들의 작업(A_n)과 전담 검수(B_n)가 완료되었습니다. 중심 코어 C로서 최종 통합 판정을 내리세요.${competeExtra}

사용자 원래 요청:
"""
${userRequest}
"""
전체 완료 조건:
${overallCriteria.map((c) => `* ${c}`).join("\n")}${formatDefinitions(definitions)}

스레드 유닛별 결과 요약:
${unitsText}

아래 JSON 형식으로만 답하세요:
{
  "verdict": "PASS" 또는 "FAIL",
  "winner_unit_id": "compete 모드일 때 채택할 유닛 ID (예: unit-1), split 모드면 빈 문자열",
  "criteria_check": [{"criterion": "완료 조건", "met": true, "evidence": "직접 확인한 근거"}],
  "reason": "판정 이유",
  "rework_units": [{"unit_id": "FAIL일 때 다시 작업할 유닛 ID", "instruction": "수정 지시"}],
  "report_for_user": "PASS일 때 사용자에게 전달할 최종 완료 보고서"
}`;
}

// 하위 호환 별칭
export const systemPromptLeaderA = systemPromptLeaderC;
export const systemPromptMakerCn = systemPromptMakerAn;
export const planUnitsPromptForA = planUnitsPromptForC;
export const judgeIntegrationPromptForA = judgeIntegrationPromptForC;
