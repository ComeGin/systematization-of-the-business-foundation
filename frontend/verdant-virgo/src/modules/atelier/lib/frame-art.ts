// 展示の壁の額に貼る絵（2D の canvas）を描く（spec §8）。島（実行時）と書き出しの道具（tools/capture-stills.mjs）が同じ関数を使う。
// 文字の正本は site-content（ATELIER.frames・cases.ts）。額の板 frame_NN は 0.48m × 0.63m なので、絵も同じ縦横比（480×630）。
// 日本語は単語の区切りが無いので、1 文字ずつ幅を測って折り返す。

export interface FrameArt {
  title: string;
  body: string;
}

const W = 480;
const H = 630;
const PAD = 44;
const PAPER = "#f4f1ea";
const INK = "#1d2433";
const MUTED = "#4a5263";
const ACCENT = "#0f6fd6";

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of [...text]) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      // 句読点・閉じ括弧は行頭に置かない（前の行に残す）
      if (/[、。，．）」』・]/.test(ch)) {
        lines.push(next);
        line = "";
        continue;
      }
      lines.push(line);
      line = ch;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** 額 1 枚ぶんの絵。fontFamily は描く側のページの文字（実行時はサイトの和文の書体） */
export function drawFrameArt(
  art: FrameArt,
  fontFamily = '"Noto Sans JP", sans-serif',
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  // 上の細い線（額の中の台紙らしさ）
  ctx.fillStyle = ACCENT;
  ctx.fillRect(PAD, PAD, 56, 6);
  ctx.textBaseline = "top";
  ctx.fillStyle = INK;
  ctx.font = `700 40px ${fontFamily}`;
  let y = PAD + 36;
  for (const line of wrap(ctx, art.title, W - PAD * 2)) {
    ctx.fillText(line, PAD, y);
    y += 54;
  }
  y += 18;
  ctx.fillStyle = MUTED;
  ctx.font = `400 26px ${fontFamily}`;
  for (const line of wrap(ctx, art.body, W - PAD * 2)) {
    if (y > H - PAD - 30) break;
    ctx.fillText(line, PAD, y);
    y += 42;
  }
  return canvas;
}
