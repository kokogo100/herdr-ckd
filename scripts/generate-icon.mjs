#!/usr/bin/env node
// Herdr CKD 전용 고해상도 아이콘 생성기 (SVG + 512px PNG + 다중 해상도 Windows .ico)
// 중심 코어 A(황금빛 코어)에서 3개의 병렬 스레드 세트([B1·C1], [B2·C2], [B3·C3])로 뻗어나가는 다중 스레드 아키텍처 심볼
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const assetsDir = path.join(projectRoot, "assets");
fs.mkdirSync(assetsDir, { recursive: true });

const svgPath = path.join(assetsDir, "herdr-ckd.svg");
const pngPath = path.join(assetsDir, "herdr-ckd.png");
const icoPath = path.join(assetsDir, "herdr-ckd.ico");

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#171B26"/>
      <stop offset="55%" stop-color="#0F1219"/>
      <stop offset="100%" stop-color="#090B10"/>
    </linearGradient>
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#F59E0B" stop-opacity="0.85"/>
      <stop offset="50%" stop-color="#8B5CF6" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#10B981" stop-opacity="0.85"/>
    </linearGradient>
    <linearGradient id="coreGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FDE68A"/>
      <stop offset="45%" stop-color="#F59E0B"/>
      <stop offset="100%" stop-color="#D97706"/>
    </linearGradient>
    <filter id="glow" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="10" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- App Squircle Background -->
  <rect x="20" y="20" width="472" height="472" rx="104" fill="url(#bgGrad)" stroke="url(#borderGrad)" stroke-width="10"/>
  <rect x="34" y="34" width="444" height="444" rx="92" fill="none" stroke="#FFFFFF" stroke-opacity="0.06" stroke-width="3"/>

  <!-- Subtle Grid Lines -->
  <line x1="256" y1="60" x2="256" y2="452" stroke="#ffffff" stroke-opacity="0.04" stroke-width="2"/>
  <line x1="60" y1="256" x2="452" y2="256" stroke="#ffffff" stroke-opacity="0.04" stroke-width="2"/>

  <!-- Branching Circuit Lines from Leader A (top) to 3 Thread Units [B1·C1], [B2·C2], [B3·C3] (bottom) -->
  <path d="M 256 175 C 256 245, 116 235, 116 320" fill="none" stroke="#F59E0B" stroke-width="14" stroke-linecap="round"/>
  <path d="M 256 175 L 256 320" fill="none" stroke="#8B5CF6" stroke-width="14" stroke-linecap="round"/>
  <path d="M 256 175 C 256 245, 396 235, 396 320" fill="none" stroke="#10B981" stroke-width="14" stroke-linecap="round"/>

  <!-- Unit 1 Card [B1 · C1] (Left - Amber/Blue) -->
  <rect x="62" y="308" width="108" height="120" rx="24" fill="#161B26" stroke="#F59E0B" stroke-width="7"/>
  <circle cx="96" cy="352" r="16" fill="#F59E0B"/>
  <circle cx="136" cy="352" r="16" fill="#38BDF8"/>
  <rect x="80" y="388" width="72" height="14" rx="7" fill="#F59E0B" fill-opacity="0.85"/>

  <!-- Unit 2 Card [B2 · C2] (Center - Purple/Cyan) -->
  <rect x="202" y="308" width="108" height="120" rx="24" fill="#161B26" stroke="#8B5CF6" stroke-width="7"/>
  <circle cx="236" cy="352" r="16" fill="#A78BFA"/>
  <circle cx="276" cy="352" r="16" fill="#38BDF8"/>
  <rect x="220" y="388" width="72" height="14" rx="7" fill="#A78BFA" fill-opacity="0.85"/>

  <!-- Unit 3 Card [B3 · C3] (Right - Emerald/Cyan) -->
  <rect x="342" y="308" width="108" height="120" rx="24" fill="#161B26" stroke="#10B981" stroke-width="7"/>
  <circle cx="376" cy="352" r="16" fill="#10B981"/>
  <circle cx="416" cy="352" r="16" fill="#38BDF8"/>
  <rect x="360" y="388" width="72" height="14" rx="7" fill="#10B981" fill-opacity="0.85"/>

  <!-- Central Leader Core A (Top Center) -->
  <circle cx="256" cy="142" r="68" fill="#F59E0B" fill-opacity="0.18" filter="url(#glow)"/>
  <circle cx="256" cy="142" r="56" fill="url(#coreGrad)" stroke="#FEF3C7" stroke-width="6"/>
  <!-- Lightning / A Symbol inside Core -->
  <path d="M 264 102 L 234 146 L 257 146 L 248 182 L 282 136 L 259 136 Z" fill="#0F1219"/>
</svg>
`;

fs.writeFileSync(svgPath, svgContent, "utf8");

// Windows .NET System.Drawing (GDI+ AntiAlias)으로 고해상도 PNG 및 멀티 사이즈 .ico (16, 32, 48, 64, 128, 256) 생성
const csharpIconGen = `using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class IconGenerator
{
    private static GraphicsPath RoundedRect(RectangleF bounds, float radius)
    {
        float d = radius * 2f;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static Bitmap RenderMasterIcon(int size)
    {
        Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);

            float s = size / 512f;
            g.ScaleTransform(s, s);

            // 1. Squircle background
            RectangleF bgRect = new RectangleF(20, 20, 472, 472);
            using (GraphicsPath bgPath = RoundedRect(bgRect, 104))
            {
                using (LinearGradientBrush bgBrush = new LinearGradientBrush(
                    new PointF(0, 0), new PointF(512, 512),
                    Color.FromArgb(255, 24, 29, 42),
                    Color.FromArgb(255, 10, 12, 18)))
                {
                    g.FillPath(bgBrush, bgPath);
                }

                using (LinearGradientBrush borderBrush = new LinearGradientBrush(
                    new PointF(0, 0), new PointF(512, 512),
                    Color.FromArgb(240, 245, 158, 11),
                    Color.FromArgb(240, 16, 185, 129)))
                using (Pen borderPen = new Pen(borderBrush, 12f))
                {
                    g.DrawPath(borderPen, bgPath);
                }
            }

            // 2. Outer glow behind Leader A
            using (GraphicsPath glowPath = new GraphicsPath())
            {
                glowPath.AddEllipse(256 - 88, 140 - 88, 176, 176);
                using (PathGradientBrush pgb = new PathGradientBrush(glowPath))
                {
                    pgb.CenterColor = Color.FromArgb(110, 245, 158, 11);
                    pgb.SurroundColors = new Color[] { Color.FromArgb(0, 245, 158, 11) };
                    g.FillPath(pgb, glowPath);
                }
            }

            // 3. Branching circuit paths from A(256, 175) to Unit 1(116, 315), Unit 2(256, 315), Unit 3(396, 315)
            using (Pen p1 = new Pen(Color.FromArgb(255, 245, 158, 11), 16f))
            using (Pen p2 = new Pen(Color.FromArgb(255, 139, 92, 246), 16f))
            using (Pen p3 = new Pen(Color.FromArgb(255, 16, 185, 129), 16f))
            {
                p1.StartCap = LineCap.Round; p1.EndCap = LineCap.Round;
                p2.StartCap = LineCap.Round; p2.EndCap = LineCap.Round;
                p3.StartCap = LineCap.Round; p3.EndCap = LineCap.Round;

                g.DrawBezier(p1, new PointF(256, 175), new PointF(256, 248), new PointF(116, 235), new PointF(116, 312));
                g.DrawLine(p2, new PointF(256, 175), new PointF(256, 312));
                g.DrawBezier(p3, new PointF(256, 175), new PointF(256, 248), new PointF(396, 235), new PointF(396, 312));
            }

            // 4. Three Thread Unit Cards [B1·C1], [B2·C2], [B3·C3]
            float[] centers = new float[] { 116f, 256f, 396f };
            Color[] unitColors = new Color[] {
                Color.FromArgb(255, 245, 158, 11),
                Color.FromArgb(255, 167, 139, 250),
                Color.FromArgb(255, 16, 185, 129)
            };
            Color checkerCyan = Color.FromArgb(255, 56, 189, 248);

            for (int i = 0; i < 3; i++)
            {
                float cx = centers[i];
                RectangleF cardRect = new RectangleF(cx - 54f, 306f, 108f, 122f);
                using (GraphicsPath cardPath = RoundedRect(cardRect, 24f))
                using (SolidBrush cardFill = new SolidBrush(Color.FromArgb(255, 22, 27, 38)))
                using (Pen cardPen = new Pen(unitColors[i], 8f))
                {
                    g.FillPath(cardFill, cardPath);
                    g.DrawPath(cardPen, cardPath);
                }

                // Maker C_n dot + Checker B_n dot
                using (SolidBrush bMaker = new SolidBrush(unitColors[i]))
                using (SolidBrush bChecker = new SolidBrush(checkerCyan))
                {
                    g.FillEllipse(bMaker, cx - 36f, 334f, 32f, 32f);
                    g.FillEllipse(bChecker, cx + 4f, 334f, 32f, 32f);
                }

                // Status bar inside unit card
                RectangleF barRect = new RectangleF(cx - 34f, 386f, 68f, 14f);
                using (GraphicsPath barPath = RoundedRect(barRect, 7f))
                using (SolidBrush barBrush = new SolidBrush(Color.FromArgb(220, unitColors[i].R, unitColors[i].G, unitColors[i].B)))
                {
                    g.FillPath(barBrush, barPath);
                }
            }

            // 5. Central Leader Core A Circle
            RectangleF coreRect = new RectangleF(256 - 58, 140 - 58, 116, 116);
            using (LinearGradientBrush coreBrush = new LinearGradientBrush(
                coreRect,
                Color.FromArgb(255, 253, 230, 138),
                Color.FromArgb(255, 217, 119, 6),
                45f))
            using (Pen corePen = new Pen(Color.FromArgb(255, 254, 243, 199), 7f))
            {
                g.FillEllipse(coreBrush, coreRect);
                g.DrawEllipse(corePen, coreRect);
            }

            // Lightning Bolt / Leader Symbol inside Core A
            PointF[] bolt = new PointF[] {
                new PointF(265, 98),
                new PointF(232, 144),
                new PointF(256, 144),
                new PointF(246, 182),
                new PointF(282, 134),
                new PointF(258, 134)
            };
            using (SolidBrush boltBrush = new SolidBrush(Color.FromArgb(255, 15, 18, 25)))
            {
                g.FillPolygon(boltBrush, bolt);
            }
        }
        return bmp;
    }

    public static void WriteMultiSizeIco(string outIcoPath, int[] sizes)
    {
        List<byte[]> pngFrames = new List<byte[]>();
        foreach (int sz in sizes)
        {
            using (Bitmap bmp = RenderMasterIcon(sz))
            using (MemoryStream ms = new MemoryStream())
            {
                bmp.Save(ms, ImageFormat.Png);
                pngFrames.Add(ms.ToArray());
            }
        }

        using (FileStream fs = new FileStream(outIcoPath, FileMode.Create, FileAccess.Write))
        using (BinaryWriter bw = new BinaryWriter(fs))
        {
            // ICONDIR header
            bw.Write((ushort)0); // reserved
            bw.Write((ushort)1); // type: 1 = ICO
            bw.Write((ushort)sizes.Length); // count

            int offset = 6 + (16 * sizes.Length);
            for (int i = 0; i < sizes.Length; i++)
            {
                int sz = sizes[i];
                byte dim = sz >= 256 ? (byte)0 : (byte)sz;
                byte[] data = pngFrames[i];

                bw.Write(dim);             // width
                bw.Write(dim);             // height
                bw.Write((byte)0);         // color count
                bw.Write((byte)0);         // reserved
                bw.Write((ushort)1);       // color planes
                bw.Write((ushort)32);      // bits per pixel
                bw.Write((uint)data.Length); // bytes in resource
                bw.Write((uint)offset);    // image offset
                offset += data.Length;
            }

            for (int i = 0; i < pngFrames.Count; i++)
            {
                bw.Write(pngFrames[i]);
            }
        }
    }

    public static int Main(string[] args)
    {
        string pngOut = args[0];
        string icoOut = args[1];

        using (Bitmap master = RenderMasterIcon(512))
        {
            master.Save(pngOut, ImageFormat.Png);
        }

        WriteMultiSizeIco(icoOut, new int[] { 16, 32, 48, 64, 128, 256 });
        return 0;
    }
}
`;

function findCscExe() {
  const windir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

if (process.platform === "win32") {
  const csc = findCscExe();
  if (csc) {
    const tmpCs = path.join(os.tmpdir(), `HerdrIconGen_${process.pid}.cs`);
    const tmpExe = path.join(os.tmpdir(), `HerdrIconGen_${process.pid}.exe`);
    fs.writeFileSync(tmpCs, csharpIconGen, "utf8");
    try {
      execFileSync(csc, ["/nologo", "/optimize+", "/r:System.Drawing.dll", `/out:${tmpExe}`, tmpCs], { stdio: "inherit" });
      execFileSync(tmpExe, [pngPath, icoPath], { stdio: "inherit" });
      console.log(`[Herdr CKD] 아이콘 생성 완료: ${icoPath}, ${pngPath}, ${svgPath}`);
    } finally {
      try { fs.unlinkSync(tmpCs); } catch {}
      try { fs.unlinkSync(tmpExe); } catch {}
    }
  }
}
