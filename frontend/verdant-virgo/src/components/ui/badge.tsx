import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const badgeVariants = cva(
  "group/badge phrase inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        // Figma の Badge（Secondary）: 地 role/surface-subtle・文字 role/text-heading（「必須」・カテゴリ・サービス名）
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        // 強調バッジ: 地 role/surface-accent-subtle・文字 role/text-accent-subtle（告知帯の「無料公開中」）
        accent: "bg-accent text-accent-foreground",
        // 重みを下げたバッジ: 「任意」（02-component-map.md §7.5）
        muted: "bg-secondary text-muted-foreground",
        destructive:
          "bg-destructive/10 text-destructive [a]:hover:bg-destructive/20",
        // Figma の Badge（Outline）: 地 role/surface・枠 role/border・文字 role/text-body（「要確認」「準備中」）
        outline: "border-border bg-surface text-foreground [a]:hover:bg-muted",
        ghost:
          "hover:bg-muted hover:text-muted-foreground",
        link: "text-text-link underline hover:text-text-link-hover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

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
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
