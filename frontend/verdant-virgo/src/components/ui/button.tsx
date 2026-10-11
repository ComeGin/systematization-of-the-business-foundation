import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

/*
 * Figma の kit Button - Nova に合わせた見た目（02-component-map.md §3.2・§7、03-handoff.md H-7・H-13）。
 * - 主ボタン（default）: 地 role/surface-brand、ラベル UI/Button（16px Bold）、左右 16px（CTAButton の上書き）
 * - 副ボタン（outline / secondary / ghost）: ラベル UI/Button Subtle（16px Medium）、左右 10px
 * - link: role/text-link ＋ 下線、ラベル UI/Label（14px Medium）
 * 高さは 16px / 行送り 24px のラベルに上下の余白を足した値（Small 32 / Default 36 / Large 40）。
 * フォーカスリングは global.css の :focus-visible に一本化している（H-8）。
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg bg-clip-padding whitespace-nowrap transition-all select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // 枠は variant ごとに持つ（base に border・border-transparent を置くと、cn を通さずに使ったとき outline の枠が消える。link は枠なし）
      variant: {
        default:
          "border border-transparent bg-primary text-primary-foreground text-base leading-6 font-bold hover:bg-surface-brand-hover hover:opacity-90",
        outline:
          "border border-border-brand bg-surface text-text-heading text-base leading-6 font-medium hover:bg-surface-subtle aria-expanded:bg-surface-subtle",
        secondary:
          "border border-transparent bg-secondary text-secondary-foreground text-base leading-6 font-medium hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary",
        // ghost・link の地は白（kit の alpha/white/outline-bg → role/surface。02-component-map.md §9.1）。淡色の面の上では白いボタンに見える
        ghost:
          "border border-transparent bg-surface text-text-heading text-base leading-6 font-medium hover:bg-muted aria-expanded:bg-muted",
        destructive:
          "border border-transparent bg-destructive/10 text-destructive text-base leading-6 font-medium hover:bg-destructive/20",
        link: "bg-surface text-text-link text-sm leading-5 font-medium underline hover:text-text-link-hover",
      },
      // Figma の CTAButton の実寸 32／36／40（ラベル 16px・行送り 24px のため base-nova の h-7／h-8／h-9 より 4px 高い）
      size: {
        default:
          "h-9 gap-1.5 px-2.5",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-2.5",
        lg: "h-10 gap-1.5 px-2.5",
        icon: "size-8",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-md",
        "icon-lg": "size-9",
      },
    },
    compoundVariants: [
      // 主ボタンだけ左右 16px（kit の 10px では 16px Bold のラベルが枠に接する。02-component-map.md §9.4）
      { variant: "default", size: ["default", "sm", "lg"], class: "px-4" },
      // link はラベルが 14px / 行送り 20px なので 1 段低い
      { variant: "link", size: "sm", class: "h-7" },
      { variant: "link", size: "default", class: "h-8" },
      { variant: "link", size: "lg", class: "h-9" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
