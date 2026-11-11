// 開発スタックのうち、この結合テストが使う n8n・Chatwoot と、改善ループ（improvement-cycle.test.ts）が使う Strapi・Mautic
// （と状態ファイル）だけの疎通を先に確かめる。確認の本体は integration の共通の global-setup（IT_SERVICES で対象を絞れる。
// 例: 改善ループだけを走らせるなら IT_SERVICES=strapi,mautic）。
import sharedGlobalSetup from "../../../integration/tests/helpers/global-setup.ts";

export default async function globalSetup(): Promise<void> {
  process.env.IT_SERVICES ??= "n8n,chatwoot,strapi,mautic";
  await sharedGlobalSetup();
}
