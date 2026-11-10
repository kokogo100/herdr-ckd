// 사용자가 첨부한 파일을 A·B·C가 쓸 수 있게 준비한다.
// * 이미지(png, jpg, gif, webp): 메시지에 그림으로 붙인다.
// * 문서(docx, pptx, xlsx, pdf, odt, odp, ods, rtf): officeparser로 글자를 뽑아 .txt로 저장하고, 문서 속 그림과 PDF 앞 몇 쪽은 그림으로 붙인다.
// * 3D 파일: 지원하지 않는다. 렌더링한 이미지로 바꿔 첨부하라고 안내한다.
// * 그 밖의 파일: 글자 파일로 보고 read_file로 읽게 한다.
// officeparser, pdf-to-png-converter는 optionalDependencies라 없으면 원본 경로만 안내한다.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { imagePart, isImage } from "./images.js";
import type { ContentPart } from "./llm.js";

const DOC_EXT = new Set([".docx", ".pptx", ".xlsx", ".pdf", ".odt", ".odp", ".ods", ".rtf"]);
const MODEL_3D_EXT = new Set([".glb", ".gltf", ".obj", ".fbx", ".stl", ".blend", ".3ds", ".dae", ".usdz", ".ply"]);

export interface AttachmentLimits {
  vision: boolean; // false면 이미지를 붙이지 않고 경로와 설명만 준다
  maxImages: number;
  maxImageBytes: number;
  pdfPages: number; // PDF에서 그림으로 붙일 앞쪽 페이지 수
}

export interface PreparedAttachments {
  notes: string[]; // 프롬프트에 넣을 파일별 안내
  images: ContentPart[];
  warnings: string[];
}

async function loadOptional(name: string): Promise<any | undefined> {
  try {
    const require = createRequire(import.meta.url);
    return await import(pathToFileURL(require.resolve(name)).href);
  } catch {
    return undefined;
  }
}

// officeparser v8은 글자 대신 문서 구조(AST)를 돌려준다. to("text")가 있으면 쓰고, 없으면 구조에서 text를 모은다.
async function documentText(result: any): Promise<string> {
  if (typeof result?.to === "function") {
    try {
      const out = await result.to("text");
      if (typeof out?.value === "string") return out.value;
    } catch {
      // 구조에서 직접 모은다
    }
  }
  const lines: string[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes ?? []) {
      if (n?.children?.length) walk(n.children);
      else if (typeof n?.text === "string") lines.push(n.text);
    }
  };
  walk(result?.content ?? []);
  return lines.join("\n");
}

export async function prepareAttachments(files: string[], outDir: string, limits: AttachmentLimits): Promise<PreparedAttachments> {
  const notes: string[] = [];
  const images: ContentPart[] = [];
  const warnings: string[] = [];
  // 이미지 상한을 넘으면 경로 안내만 하고 붙이지 않는다.
  const addImage = (file: string): string => {
    if (!limits.vision) return "그림 보기가 꺼져 있어 붙이지 않음";
    if (images.length >= limits.maxImages) {
      warnings.push(`첨부 이미지가 ${limits.maxImages}장을 넘어 붙이지 않았습니다: ${file}`);
      return `이미지 상한(${limits.maxImages}장)을 넘어 붙이지 않음, view_image로 볼 수 있음`;
    }
    if (fs.statSync(file).size > limits.maxImageBytes) {
      warnings.push(`이미지가 ${Math.round(limits.maxImageBytes / 1024 / 1024)}MB를 넘어 붙이지 않았습니다: ${file}`);
      return "너무 커서 붙이지 않음";
    }
    images.push(imagePart(file));
    return "이 메시지에 그림으로 붙어 있음, view_image로 다시 볼 수 있음";
  };

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file, ext);
    try {
      if (isImage(file)) {
        notes.push(`${file} (참고 이미지: ${addImage(file)})`);
      } else if (MODEL_3D_EXT.has(ext)) {
        warnings.push(`3D 파일은 지원하지 않습니다: ${file}`);
        notes.push(`${file} (3D 파일은 직접 볼 수 없습니다. 사용자에게 렌더링한 이미지로 바꿔 첨부해 달라고 하세요)`);
      } else if (DOC_EXT.has(ext)) {
        const office = await loadOptional("officeparser");
        if (!office?.parseOffice) {
          warnings.push(`문서 변환 도구(officeparser)가 없어 원본만 첨부합니다: ${file}`);
          notes.push(`${file} (문서: 변환 도구가 없어 내용을 읽을 수 없음)`);
          continue;
        }
        fs.mkdirSync(outDir, { recursive: true });
        const parsed = await office.parseOffice(file, { extractAttachments: true, allowRemoteAssets: false });
        const textFile = path.join(outDir, `${base}${ext.replace(".", "_")}.txt`);
        fs.writeFileSync(textFile, await documentText(parsed), "utf8");
        const parts = [`글자: ${textFile} 을 read_file로 읽기`];
        // 문서 속 그림
        let embedded = 0;
        for (const [i, a] of (parsed.attachments ?? []).entries()) {
          const data = a?.data ?? a?.content;
          const mime = String(a?.mimeType ?? a?.type ?? "");
          if (!data || !/image\/(png|jpe?g|gif|webp)|^image$/.test(mime)) continue;
          const imgExt = mime.includes("png") ? ".png" : mime.includes("gif") ? ".gif" : mime.includes("webp") ? ".webp" : ".jpg";
          const imgFile = path.join(outDir, `${base}-그림${i + 1}${imgExt}`);
          fs.writeFileSync(imgFile, typeof data === "string" ? Buffer.from(data, "base64") : Buffer.from(data));
          if (addImage(imgFile).startsWith("이 메시지")) embedded++;
        }
        if (embedded) parts.push(`문서 속 그림 ${embedded}장을 붙임`);
        // PDF는 앞 몇 쪽을 그림으로
        if (ext === ".pdf" && limits.vision && limits.pdfPages > 0) {
          const pdf = await loadOptional("pdf-to-png-converter");
          if (pdf?.pdfToPng) {
            const pages = await pdf.pdfToPng(file, { viewportScale: 1, pagesToProcess: Array.from({ length: limits.pdfPages }, (_, k) => k + 1), returnPageContent: true });
            let shown = 0;
            for (const p of pages) {
              const pageFile = path.join(outDir, `${base}-p${p.pageNumber}.png`);
              fs.writeFileSync(pageFile, p.content);
              if (addImage(pageFile).startsWith("이 메시지")) shown++;
            }
            parts.push(`앞 ${shown}쪽을 그림으로 붙임`);
          } else warnings.push("PDF 페이지 그림 도구(pdf-to-png-converter)가 없어 글자만 첨부합니다.");
        }
        notes.push(`${file} (문서: ${parts.join(", ")})`);
      } else {
        notes.push(`${file} (글자 파일: read_file로 읽기)`);
      }
    } catch (err) {
      warnings.push(`첨부 파일을 준비하지 못했습니다: ${file}: ${(err as Error).message}`);
      notes.push(`${file} (준비 실패, 원본 경로만 있음)`);
    }
  }
  return { notes, images, warnings };
}
