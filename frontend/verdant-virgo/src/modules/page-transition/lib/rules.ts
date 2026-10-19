// ページ移動の演出（形のつながり）を出さないパスの規則。DOM に触れない純粋な関数だけを置く。
// 規約・ポリシー（/legal/ 配下）は区分 C（none）。入るときも出るときも演出しない。

/** 規約・ポリシー（区分 C）のパスか。"/legal/" で始まるときだけ true（"/legalese/" は false） */
export function isStillPath(pathname: string): boolean {
  return pathname.startsWith("/legal/");
}

/** 移動元か移動先のどちらかが C のページなら、演出を飛ばす */
export function shouldSkipTransition(fromPath: string, toPath: string): boolean {
  return isStillPath(fromPath) || isStillPath(toPath);
}
