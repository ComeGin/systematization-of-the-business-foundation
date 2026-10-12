import type { Reply } from "../chatwoot/types.js";
import { MAX_WELCOME_ITEMS, MESSAGES, WELCOME_PAGE_KEY } from "../constants.js";
import type { FaqItem } from "../faq/schema.js";
import type { FaqSnapshot } from "../faq/store.js";
import { candidateTitle } from "./decide.js";

// faq-export の id は「<ページの key>-<元の順番>」。key にはハイフンが入りうる（services-<slug>）ので、後ろが数字だけのものに限る
const WELCOME_ID = new RegExp(`^${WELCOME_PAGE_KEY}-\\d+$`);

/** ウィジェットを開いたときに出す FAQ（2026-10-12 の仕様 3 節）。トップページの項目を faq.json の順に最大 6 件 */
export function welcomeItems(snapshot: Pick<FaqSnapshot, "items">): FaqItem[] {
  return snapshot.items.filter((item) => WELCOME_ID.test(item.id)).slice(0, MAX_WELCOME_ITEMS);
}

/** 一覧のメッセージ。選ばれると既存の「選択: FAQ の id」の流れ（decide.ts）で答える */
export function welcomeReply(items: readonly FaqItem[]): Reply {
  return {
    kind: "select",
    content: MESSAGES.welcome,
    items: items.map((item) => ({ title: candidateTitle(item), value: item.id })),
  };
}
