import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

// 高さは min-h-5 で、折り返しも止めない（固定の h-5・overflow-hidden・whitespace-nowrap だと、文字の間隔を広げたとき〈WCAG 1.4.12〉や
// 狭い幅〈1.4.10〉で文字が切れる・はみ出す）。w-fit なので、収まる幅では今までどおり 1 行。
// 上下の余白は py-px（行 16px ＋ 2px ＋ 枠 2px ＝ 20px で、h-5 のときの見た目の高さと同じ）
const badgeVariants = cva(
  "group/badge phrase inline-flex min-h-5 w-fit shrink-0 items-center justify-center gap-1 rounded-full border border-transparent px-2 py-px text-xs leading-4 font-medium transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        // リンクのときの hover は地を blue.700 に（bg-primary/80 だと白い面が透けて 3.59:1。WCAG 1.4.3）
        default:
          "bg-primary text-primary-foreground [a]:hover:bg-surface-brand-hover",
        // Figma の Badge（Secondary）: 地 role/surface-subtle・文字 role/text-heading（「必須」・カテゴリ・サービス名）
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        // 強調バッジ: 地 role/surface-accent-subtle・文字 role/text-accent-subtle（告知帯の「無料公開中」）
        accent: "bg-accent text-accent-foreground",
        // 重みを下げたバッジ: 「任意」（02-component-map.md §7.5）
        muted: "bg-secondary text-muted-foreground",
        // リンクのときの hover は枠で示す（地を /20 にすると 4.15:1 になるので、地は /10〈4.86:1〉のまま。button の destructive と同じ。WCAG 1.4.3）
        destructive:
          "bg-destructive/10 text-destructive [a]:hover:border-destructive",
        // Figma の Badge（Outline）: 地 role/surface・枠 role/border・文字 role/text-body（「要確認」「準備中」）
        outline: "border-border bg-surface text-foreground [a]:hover:bg-muted",
        ghost: "hover:bg-muted hover:text-muted-foreground",
        link: "text-text-link underline hover:text-text-link-hover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
