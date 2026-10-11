// テストで作るデータの名前。どれも `it-` で始め、実行ごとに一意な接尾辞を付ける。
// 後片付けに失敗しても、名前で見つけて消せる（README の「残ったデータの消し方」）。
import { randomBytes } from "node:crypto";

export const IT_PREFIX = "it-";

/** 1 回の vitest の実行（ファイル単位）で 1 つ。並べて走っても衝突しない */
export const RUN_ID = `${IT_PREFIX}${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

/** テストデータの名前（例: it-mf3k2-a1b2c3-contact） */
export const itName = (label: string): string => `${RUN_ID}-${label}`;

/** テストデータのメールアドレス。example.com は配送されないドメイン（RFC 2606） */
export const itEmail = (label: string): string => `${RUN_ID}-${label}@example.com`.toLowerCase();
