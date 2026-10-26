// Cal.com（SaaS。オンプレの外）の embed.js の代わり。完了画面の予約枠（booking/components/BookingFrame.tsx）が頼る約束だけを満たす:
//   - booking/lib/calcom.ts の loader が積んだ命令の列（Cal.ns.<名前>.q）を読み、inline で枠の中に iframe を差し込む
//   - on で登録された callback に通知（CustomEvent。detail.type）を返す。"*" は全部の通知を受ける
// 本物の embed.js の内部には合わせない（出典の公開の約束: https://cal.com/help/embedding/embed-events）。
// 予約の完了などの通知は、テストから window.__e2eCal.emit("bookingSuccessfulV2") で起こす。

/** ready: 枠を差し込んで linkReady を返す / silent: 何もしない（15 秒の待ちで代わりの案内になる） */
export type CalcomMode = "ready" | "silent" | "fail";

/** 偽物の予約枠の中身（iframe の srcdoc）。時間枠のボタンだけ */
export const FAKE_SLOT_LABEL = "10:00（e2e の偽の時間枠）";

export function calcomStub(mode: Exclude<CalcomMode, "fail">): string {
  return `(() => {
  const Cal = window.Cal;
  if (!Cal || !Cal.ns) return;
  const handlers = {};
  const emit = (ns, type, data) => {
    for (const h of handlers[ns] || []) {
      if (h.action === "*" || h.action === type) h.callback(new CustomEvent(type, { detail: { type, data, namespace: ns } }));
    }
  };
  const handle = (ns, args) => {
    const [command, options] = args;
    if (command === "on") (handlers[ns] ||= []).push(options);
    if (command === "inline" && ${JSON.stringify(mode)} === "ready") {
      const target = document.querySelector(options.elementOrSelector);
      if (!target) return;
      const frame = document.createElement("iframe");
      frame.title = "Book a call";
      frame.srcdoc = ${JSON.stringify(`<button type="button" data-testid="time">${FAKE_SLOT_LABEL}</button>`)};
      target.appendChild(frame);
      setTimeout(() => emit(ns, "linkReady", {}), 50);
    }
  };
  for (const [ns, api] of Object.entries(Cal.ns)) for (const args of api.q || []) handle(ns, args);
  window.__e2eCal = { emit: (type, data) => { for (const ns of Object.keys(Cal.ns)) emit(ns, type, data); } };
})();`;
}
