// アバターの記憶（sessionStorage。タブを閉じると消える）。読み書きは try/catch で囲み、使えない環境（プライベートモードの制限など）では
// 「覚えていない」として振る舞う（例外を外へ出さない）。一時停止の記憶は a11y の MotionPause が storageKey motion:avatar で持つので、ここでは扱わない。
//   avatar:collapsed … たたんだか（ページを移っても保つ。設計書 §7.2）
//   avatar:greeted   … このセッションで手を振ったか（着いたときの挨拶は 1 回だけ。R17）

const COLLAPSED_KEY = "avatar:collapsed";
const GREETED_KEY = "avatar:greeted";

function read(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function write(key: string, value: boolean): void {
  try {
    if (value) window.sessionStorage.setItem(key, "true");
    else window.sessionStorage.removeItem(key);
  } catch {
    // 覚えられないときは、このページの中だけの状態にする
  }
}

/** たたんだ状態か（保存されていなければ false） */
export function readCollapsed(): boolean {
  return read(COLLAPSED_KEY);
}

export function writeCollapsed(v: boolean): void {
  write(COLLAPSED_KEY, v);
}

/** このセッションで、着いたときの挨拶（greeting）を済ませたか */
export function readGreeted(): boolean {
  return read(GREETED_KEY);
}

export function writeGreeted(): void {
  write(GREETED_KEY, true);
}
