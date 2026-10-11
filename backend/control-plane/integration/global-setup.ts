// 開発スタックのうち、この結合テストが使う n8n と Chatwoot（と状態ファイル）だけの疎通を先に確かめる。
// 確認の本体は integration の共通の global-setup（IT_SERVICES で対象を絞れる）。
import sharedGlobalSetup from "../../../integration/tests/helpers/global-setup.ts";

export default async function globalSetup(): Promise<void> {
  process.env.IT_SERVICES ??= "n8n,chatwoot";
  await sharedGlobalSetup();
}
