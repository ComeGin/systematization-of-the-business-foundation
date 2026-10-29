// Tips から下層ページへの受け渡し（spec §9 の 3）。three・DOM に依存しない。
// トップの島は、カメラが移り先の静止画と同じ位置・角度に着いたら writeVt して移る。行き先の冒頭の静止画（AtelierStill の inline script）は、
// 同じ判定（行き先が合い、2 秒以内）で、遷移の間だけ同じ view-transition-name（vt-atelier）を付ける。読んだら消す
// （ブラウザーの「戻る」・別のページで、古い受け渡しを使わない）。inline script は同じ規則を自前で持つ（define:vars で VT_MAX_AGE_MS を渡す）。
import type { PageKey, Phase } from "./types";

export interface AtelierVt {
  from: "top";
  to: PageKey;
  phase: Phase;
  /** 書いた時刻（Date.now()） */
  at: number;
}

export const VT_STORAGE_KEY = "atelier:vt";
export const VT_MAX_AGE_MS = 2000;

export function writeVt(
  storage: Pick<Storage, "setItem"> | null,
  vt: AtelierVt,
): void {
  try {
    storage?.setItem(VT_STORAGE_KEY, JSON.stringify(vt));
  } catch {
    // 残せなくても移れる（遷移の絵がつながらないだけ）
  }
}

export function readVt(
  storage: Pick<Storage, "getItem" | "removeItem"> | null,
  page: PageKey,
  now: number,
): AtelierVt | null {
  try {
    const raw = storage?.getItem(VT_STORAGE_KEY);
    if (!raw) return null;
    storage?.removeItem(VT_STORAGE_KEY);
    const vt = JSON.parse(raw) as Partial<AtelierVt>;
    if (
      vt.from !== "top" ||
      vt.to !== page ||
      typeof vt.at !== "number" ||
      now - vt.at > VT_MAX_AGE_MS ||
      now < vt.at
    )
      return null;
    return vt as AtelierVt;
  } catch {
    return null;
  }
}

/**
 * カメラが飛ぶのを待つ。飛ぶのが終わるか、maxMs が来るか、早い方で解決する（失敗しても投げない）。
 * 飛んでいる間に遅い端末の判定で描画が止まると、飛ぶのは終わらない。そのときも、押した「見る」の行き先へ必ず移る（最終レビュー I-2）。
 */
export function afterFlight(flight: Promise<unknown>, maxMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    flight.then(finish, finish);
  });
}
