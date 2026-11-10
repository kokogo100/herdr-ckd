// 이미지를 모델에 보낼 조각으로 만든다. OpenAI 호환 Chat Completions의 image_url(data URL) 형식.
// 첨부 이미지와 view_image 결과에 쓴다. 기록에는 이미지 데이터 대신 파일 경로만 남긴다(llm.ts의 forLog).
import fs from "node:fs";
import path from "node:path";
import type { ContentPart } from "./llm.js";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export function isImage(file: string): boolean {
  return path.extname(file).toLowerCase() in MIME;
}

export function imagePart(file: string): ContentPart {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`이미지 파일이 아닙니다(png, jpg, gif, webp만 됩니다): ${file}`);
  const size = fs.statSync(file).size;
  if (size > IMAGE_MAX_BYTES) throw new Error(`이미지가 너무 큽니다(${Math.round(size / 1024 / 1024)}MB, 최대 8MB): ${file}`);
  return { type: "image_url", image_url: { url: `data:${mime};base64,${fs.readFileSync(file).toString("base64")}` }, source: file };
}
