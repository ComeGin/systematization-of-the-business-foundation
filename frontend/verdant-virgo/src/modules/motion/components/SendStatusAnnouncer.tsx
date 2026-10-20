// SendStatus の読み上げ（4.1.3）。送信ボタンの外（直前か直後の兄弟）に置く sr-only の role="status"。
// live region は先にマウントしておく必要があるので、state が idle でも要素は出したままにし、文字は送信中だけ入れる。
// 完了は読まない（無料 DL は成功の表示へのフォーカスの移動、無料相談は完了画面への遷移が伝える）。失敗は既存の Alert が伝える。
import type { SendStatusAnnouncerProps } from "../lib/types";

export default function SendStatusAnnouncer({
  state,
  sendingText,
}: SendStatusAnnouncerProps) {
  return (
    <span role="status" className="sr-only" data-motion="send-status">
      {state === "sending" ? sendingText : ""}
    </span>
  );
}
