// 全スイートの前に 1 回だけ、開発スタックと設定スクリプトの成果物がそろっているかを確かめる。
// 足りないときはテストを始めずに、何が足りないかだけを並べて止める（秘密値は出さない）。
// 一部のサービスだけを試すときは IT_SERVICES=consentApi,adminAuth のように絞れる（services.ts の名前）。
import { existsSync } from "node:fs";

import { STATE_FILE } from "./env.ts";
import { reachable } from "./http.ts";
import { DEV, HEALTH_PATH, type ServiceName } from "./services.ts";

export default async function globalSetup(): Promise<void> {
  const wanted = (process.env.IT_SERVICES?.split(",").map((s) => s.trim()).filter(Boolean) ?? Object.keys(DEV)) as ServiceName[];
  const unknown = wanted.filter((s) => !(s in DEV));
  if (unknown.length > 0) throw new Error(`IT_SERVICES に知らない名前がある: ${unknown.join(", ")}（${Object.keys(DEV).join(", ")}）`);

  const problems: string[] = [];
  if (!existsSync(STATE_FILE)) problems.push(`状態ファイル ${STATE_FILE} が無い（node setup/setup.mjs --target dev）`);
  // 監視アプリ（next dev）は再コンパイルの最中だと最初の応答に数秒かかるため、3 秒ではなく 15 秒まで待つ
  const results = await Promise.all(wanted.map(async (s) => [s, await reachable(`${DEV[s]}${HEALTH_PATH[s]}`, 15_000)] as const));
  for (const [s, ok] of results) if (!ok) problems.push(`${s}（${DEV[s]}）に届かない`);

  if (problems.length > 0) throw new Error(`開発スタックの準備が足りない:\n- ${problems.join("\n- ")}`);
}
