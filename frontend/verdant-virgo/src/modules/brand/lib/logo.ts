export type LogoLockup = 'horizontal' | 'vertical' | 'symbol';
export type LogoColor = 'fullcolor' | 'navy' | 'white';

/** 幅 ÷ 高さ。SVG マスターの viewBox から（横組み 550.382×169.092、縦組み 330.979×344.054、シンボル 264.847×236.774） */
export const LOGO_RATIO: Record<LogoLockup, number> = {
  horizontal: 550.382 / 169.092,
  vertical: 330.979 / 344.054,
  symbol: 264.847 / 236.774,
};
