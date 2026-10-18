import { cn } from "cn";
import { Loader2Icon } from "lucide-react";

/*
 * 読み込み中の輪。回すのは motion-safe のときだけ（計画書 P-5。reduced-motion では止まった輪になる）。
 * label を渡すと role="status" の枠に包み、文字を読み上げさせる。reduced-motion のときは文字も画面に出す
 * （止まった輪だけでは読み込み中だと分からないため）。文言は site-content/a11y.ts の LOADING_LABEL を渡す（既定値を持たない。H-16・H-31）。
 * label を渡さないときは装飾（aria-hidden。role も名前も持たない）。ボタンの中など、状態を文字が別に伝えるときだけ使う。
 */
function Spinner({
  className,
  label,
  ...props
}: React.ComponentProps<"svg"> & { label?: string }) {
  if (label) {
    return (
      <span
        role="status"
        data-slot="spinner"
        className="inline-flex items-center gap-2"
      >
        <Loader2Icon
          aria-hidden="true"
          className={cn("size-4 motion-safe:animate-spin", className)}
          {...props}
        />
        <span className="sr-only motion-reduce:not-sr-only">{label}</span>
      </span>
    );
  }
  return (
    <Loader2Icon
      data-slot="spinner"
      aria-hidden="true"
      className={cn("size-4 motion-safe:animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
