// marketing-ui モジュールの公開口。他モジュールはここからだけ import する。
// 静的な部品はすべて .astro（JS を出さない）。文言の既定値は持たない（03-handoff.md H-16）。
export { default as CTAButton } from './components/CTAButton.astro';
export type { Props as CTAButtonProps } from './components/CTAButton.astro';
export { default as Section } from './components/Section.astro';
export { default as SectionHeading } from './components/SectionHeading.astro';
export { default as ServiceCard } from './components/ServiceCard.astro';
export { default as PricingCard } from './components/PricingCard.astro';
export { default as IconCard } from './components/IconCard.astro';
export { default as Steps } from './components/Steps.astro';
export { default as StepItem } from './components/StepItem.astro';
export { default as FAQItem } from './components/FAQItem.astro';
export { default as CTABanner } from './components/CTABanner.astro';
export { default as BlogCard } from './components/BlogCard.astro';
export { default as LogoCloud } from './components/LogoCloud.astro';
export { default as TestimonialCard } from './components/TestimonialCard.astro';
export { default as StatCard } from './components/StatCard.astro';
export { default as ImagePlaceholder } from './components/ImagePlaceholder.astro';
export { default as BrokenHeading } from './components/BrokenHeading.astro';
export { default as HeadingLines } from './components/HeadingLines.astro';
export { default as KeepTogether } from './components/KeepTogether.astro';
export { splitKeepTogether, type TextPiece } from './lib/keep-together';
export { assertBreakableHeading, type BreakableHeading, type LineBreakAt } from './lib/heading';
export type {
  CTAButtonIcon,
  CTAButtonSize,
  CTAButtonVariant,
  HeadingLevel,
  PriceRow,
  SectionTone,
  SectionWidth,
  StepContent,
} from './lib/types';
