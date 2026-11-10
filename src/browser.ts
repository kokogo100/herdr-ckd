// 브라우저 화면 결과물을 실제로 열어 보는 도구. HTML을 file:// 그대로 열어 더블클릭 실행과 같은 조건으로 확인한다.
// playwright-core(또는 playwright)가 있으면 쓰고, 설치된 Chrome을 먼저 시도한 뒤 번들 Chromium으로 연다.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { CkdConfig } from "./config.js";

export interface BrowserAction {
  type: "click" | "right_click" | "middle_click" | "dblclick" | "both_click" | "wait" | "mouse_down" | "mouse_move" | "mouse_up" | "key_press";
  selector?: string;
  index?: number;
  ms?: number;
  button?: "left" | "right" | "middle"; // mouse_down, mouse_up에서 누르고 뗄 버튼
  key?: string; // key_press에서 누를 키 (예: ArrowUp, Enter, a)
}

export interface BrowserCheckArgs {
  target: string; // 파일 경로(작업 폴더 기준 또는 절대) 또는 http(s) 주소
  actions?: BrowserAction[];
  count?: string[]; // 개수를 셀 CSS 선택자
}

type Playwright = { chromium: { launch(opts: Record<string, unknown>): Promise<any> } };

function loadPlaywright(): Playwright | undefined {
  const require = createRequire(import.meta.url);
  for (const name of ["playwright-core", "playwright"]) {
    try {
      return require(name) as Playwright;
    } catch {
      // 다음 후보
    }
  }
  return undefined;
}

async function launch(pw: Playwright, config: CkdConfig): Promise<any> {
  const channel = config.tools.browserChannel;
  if (channel) {
    try {
      return await pw.chromium.launch({ channel, headless: true });
    } catch {
      // 설치된 브라우저가 없으면 번들 Chromium으로
    }
  }
  return pw.chromium.launch({ headless: true });
}

export async function browserCheck(args: BrowserCheckArgs, fileUrl: (p: string) => string, config: CkdConfig): Promise<string> {
  const pw = loadPlaywright();
  if (!pw) return "브라우저 확인 도구를 쓸 수 없습니다: ckd-mcp 폴더에서 npm install playwright-core 가 필요합니다.";
  const url = /^https?:\/\//.test(args.target) ? args.target : fileUrl(args.target);
  const browser = await launch(pw, config);
  const lines: string[] = [`열기: ${url}`];
  try {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failed: string[] = [];
    page.on("console", (m: any) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e: Error) => pageErrors.push(e.message));
    page.on("requestfailed", (r: any) => failed.push(`${r.url()} (${r.failure()?.errorText ?? "실패"})`));
    await page.goto(url, { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(300);

    for (const [i, a] of (args.actions ?? []).entries()) {
      if (a.type === "wait") {
        await page.waitForTimeout(Math.min(a.ms ?? 500, 10000));
        continue;
      }
      // 키보드로 조작하는 화면(게임 등)을 시험할 때 쓴다. 화면에 시험용 버튼을 따로 만들 필요가 없다.
      if (a.type === "key_press") {
        if (!a.key) {
          lines.push(`동작 ${i + 1}: key_press에는 key가 필요합니다 (예: ArrowUp)`);
          continue;
        }
        try {
          await page.keyboard.press(a.key);
          lines.push(`동작 ${i + 1}: key_press ${a.key} 완료`);
        } catch (err) {
          lines.push(`동작 ${i + 1}: key_press ${a.key} 실패: ${(err as Error).message.split("\n")[0]}`);
        }
        await page.waitForTimeout(150);
        continue;
      }
      // 버튼을 누른 채로 있는 상태를 시험할 때 쓴다 (예: 양쪽 버튼을 누른 채 마우스 이동).
      if (a.type === "mouse_down" || a.type === "mouse_up") {
        const button = a.button ?? "left";
        // selector가 있으면 그 요소 가운데로 먼저 옮긴 뒤 누르거나 뗀다. 없으면 지금 마우스 자리에서.
        if (a.selector) {
          const box = await page.locator(a.selector).nth(a.index ?? 0).boundingBox().catch(() => null);
          if (!box) {
            lines.push(`동작 ${i + 1}: ${a.type} ${a.selector}[${a.index ?? 0}] 실패: 요소가 화면에 없습니다`);
            continue;
          }
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
        }
        if (a.type === "mouse_down") await page.mouse.down({ button });
        else await page.mouse.up({ button });
        lines.push(`동작 ${i + 1}: ${a.type} ${button}${a.selector ? ` ${a.selector}[${a.index ?? 0}]` : " (지금 마우스 자리)"} 완료`);
        await page.waitForTimeout(100);
        continue;
      }
      if (a.type === "mouse_move" && !a.selector) {
        // selector 없이 움직이면 화면 왼쪽 위 구석(판 밖)으로 보낸다.
        await page.mouse.move(1, 1);
        lines.push(`동작 ${i + 1}: mouse_move 화면 구석 완료`);
        await page.waitForTimeout(100);
        continue;
      }
      if (!a.selector) {
        lines.push(`동작 ${i + 1}: selector가 없습니다`);
        continue;
      }
      const el = page.locator(a.selector).nth(a.index ?? 0);
      try {
        if (a.type === "mouse_move") {
          const box = await el.boundingBox();
          if (!box) throw new Error("요소가 화면에 없습니다");
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
        } else if (a.type === "right_click") await el.click({ button: "right", timeout: 5000 });
        else if (a.type === "middle_click") await el.click({ button: "middle", timeout: 5000 });
        else if (a.type === "dblclick") await el.dblclick({ timeout: 5000 });
        else if (a.type === "both_click") {
          // 지뢰찾기 등의 양쪽 클릭: 왼쪽과 오른쪽을 함께 눌렀다 뗀다.
          const box = await el.boundingBox();
          if (!box) throw new Error("요소가 화면에 없습니다");
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down({ button: "left" });
          await page.mouse.down({ button: "right" });
          await page.mouse.up({ button: "right" });
          await page.mouse.up({ button: "left" });
        } else if (a.type === "click") await el.click({ timeout: 5000 });
        else throw new Error(`알 수 없는 동작입니다: ${a.type}. 쓸 수 있는 동작: click, right_click, middle_click, dblclick, both_click, wait, mouse_down, mouse_move, mouse_up, key_press`);
        lines.push(`동작 ${i + 1}: ${a.type} ${a.selector}[${a.index ?? 0}] 완료`);
      } catch (err) {
        lines.push(`동작 ${i + 1}: ${a.type} ${a.selector}[${a.index ?? 0}] 실패: ${(err as Error).message.split("\n")[0]}`);
      }
      await page.waitForTimeout(150);
    }

    // 숨겨진 요소도 개수에 들어가므로(예: display:none 안의 제목), 화면에 보이는 개수를 함께 적는다.
    for (const sel of args.count ?? []) lines.push(`개수 ${sel}: ${await page.locator(sel).count()} (화면에 보이는 것 ${await page.locator(sel).filter({ visible: true }).count()})`);
    const text = String(await page.evaluate("document.body ? document.body.innerText : ''"));
    lines.push(`콘솔 오류 ${consoleErrors.length}개${consoleErrors.length ? ":\n" + consoleErrors.map((e) => `* ${e}`).join("\n") : ""}`);
    lines.push(`페이지 오류 ${pageErrors.length}개${pageErrors.length ? ":\n" + pageErrors.map((e) => `* ${e}`).join("\n") : ""}`);
    lines.push(`실패한 요청 ${failed.length}개${failed.length ? ":\n" + failed.map((e) => `* ${e}`).join("\n") : ""}`);
    lines.push(`화면 글자 (앞 1500자):\n${text.slice(0, 1500)}`);

    const shotDir = path.join(config.dataDir, "screenshots");
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = path.join(shotDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    lines.push(`스크린샷: ${shot} (view_image로 직접 볼 수 있음)`);
  } finally {
    await browser.close();
  }
  return lines.join("\n");
}

export { pathToFileURL };
