// 模型の中の人形（lib/figure.ts）が読む資産の URL（2026-10-28）。画面の端のアバター（AvatarDock）と同じファイルを使う（1 年キャッシュを共有する）。
// ほかのモジュール（diorama）は avatar の index.ts を通してこれを読む。
import modelUrl from "../assets/avatar.vrm?url";
import idleUrl from "../assets/motions/idle.json?url";
import nodUrl from "../assets/motions/nod.json?url";

export const AVATAR_FIGURE_ASSETS = { modelUrl, idleUrl, nodUrl } as const;
