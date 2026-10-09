// subset-font は型を同梱していないため、integration.ts で使う範囲だけ宣言する（README の API）。
declare module "subset-font" {
  interface SubsetFontOptions {
    targetFormat?: "sfnt" | "woff" | "woff2" | "truetype";
    preserveNameIds?: number[];
    keepFeatures?: string[];
    variationAxes?: Record<
      string,
      number | { min?: number; max?: number; default?: number }
    >;
    keepAllGlyphs?: boolean;
    noLayoutClosure?: boolean;
    glyphNames?: boolean;
    noHinting?: boolean;
    dropTables?: string[];
  }
  export default function subsetFont(
    buffer: Buffer,
    text?: string | null,
    options?: SubsetFontOptions,
  ): Promise<Buffer>;
}
