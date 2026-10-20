// SendStatus の形（体験の筋書き「託す」）。送信ボタンの中に置く。React Bits の StatusMark を形だけで使う（aria-hidden）。
// 待機の輪 → 進捗の弧（送信中）→ チェック（完了）。意味は文字が持つ（読み上げは SendStatusAnnouncer。規則 2）。
// 失敗のときは state を 'idle' に戻す（チェックにしない）。reduced-motion では回らない（StatusMark が motion の設定を見る）。
import { useEffect, useState } from "react";
import StatusMark, {
  type StatusMarkStatus,
} from "../vendor/react-bits/StatusMark/StatusMark";
import { DURATION, SPIN_PERIOD } from "../lib/tokens";
import type { SendStatusMarkProps } from "../lib/types";

export default function SendStatusMark({
  state,
  className,
}: SendStatusMarkProps) {
  // 輪（pending）から弧（running）へ形が変わるのを見せるため、送信中は 1 フレームだけ pending で描いてから running にする
  const [status, setStatus] = useState<StatusMarkStatus>("pending");
  useEffect(() => {
    if (state === "idle") {
      setStatus("pending");
      return undefined;
    }
    if (state === "done") {
      setStatus("done");
      return undefined;
    }
    const id = requestAnimationFrame(() => setStatus("running"));
    return () => cancelAnimationFrame(id);
  }, [state]);

  if (state === "idle") return null;

  return (
    <StatusMark
      decorative
      status={status}
      color="currentColor"
      doneColor="currentColor"
      errorColor="currentColor"
      size={16}
      strokeWidth={2.5}
      spinDuration={SPIN_PERIOD}
      drawDuration={DURATION.small}
      strike={false}
      className={className}
    />
  );
}
