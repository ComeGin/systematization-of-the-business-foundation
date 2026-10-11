/** 改行を入れる位置。Desktop だけ・Mobile だけ・両方 */
export type LineBreakAt = 'desktop' | 'mobile' | 'both';

/**
 * 改行位置の指定がある見出し（03-handoff.md H-19、計画書 P-3。トップ h1・1-4a の h2・会社概要 h1）。
 * segments を順につなぐと text と一字一句同じになる。breakAfter のある区間の後ろに、その端末でだけ出る <br> を置く。
 */
export interface BreakableHeading {
  readonly text: string;
  readonly segments: readonly { readonly text: string; readonly breakAfter?: LineBreakAt }[];
}

/** segments をつないだ文字列が text と同じかを確かめる（食い違いはビルドで止める） */
export function assertBreakableHeading(heading: BreakableHeading): void {
  const joined = heading.segments.map((s) => s.text).join('');
  if (joined !== heading.text) {
    throw new Error(`BreakableHeading: segments をつないだ文字列が text と一致しません。\n text: ${heading.text}\n segments: ${joined}`);
  }
}
