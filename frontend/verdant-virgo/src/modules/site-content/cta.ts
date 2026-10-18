// CTA の一覧（cta_id の正本）。01-content-spec.md §6.3 の 31 行と §4.3.4 の 11 行を写す。
// キーが cta_id のオブジェクトにしてあるので、同じ cta_id を 2 回書くと TS がエラーにする
// （「同じ cta_id を 2 画面で使わない」§6.3 の検査をコンパイル時に行う）。
// cta_type の 4 値は DA-01 の E-06 と §6.1 の F7。cta_role の 3 値は §6.2。

export type CtaType = 'consult' | 'source_dl' | 'chat' | 'booking';
export type CtaRole = 'primary' | 'secondary' | 'assist';

export interface CtaDefinition {
  readonly ctaType: CtaType;
  /** 既定の役割。画面で変わるもの（dl_article_end）は CTAButton の ctaRole で上書きする */
  readonly ctaRole: CtaRole;
  /** cta_viewed を送るか（§6.3 のイベントの列に cta_viewed があるか） */
  readonly trackView: boolean;
  /** 置いている画面（§6.3 の「画面」の列。検査と読み手のため） */
  readonly screen: string;
}

const consult = (screen: string, trackView = true): CtaDefinition => ({ ctaType: 'consult', ctaRole: 'primary', trackView, screen });
const dl = (screen: string, trackView: boolean, ctaRole: CtaRole = 'secondary'): CtaDefinition => ({
  ctaType: 'source_dl',
  ctaRole,
  trackView,
  screen,
});

export const CTAS = {
  // 全画面（§6.3 の 1〜4）
  consult_global_header: consult('全画面'),
  consult_global_sheet: consult('全画面'),
  dl_global_sheet: dl('全画面', false),
  consult_global_footer: consult('全画面', false),
  dl_global_footer: dl('全画面', false),
  // トップ（5〜10）
  dl_top_banner: dl('トップ', true),
  consult_top_hero: consult('トップ'),
  dl_top_hero: dl('トップ', true),
  dl_top_card: dl('トップ', false),
  dl_top_section: dl('トップ', true),
  consult_top_banner: consult('トップ'),
  // サービス一覧（11〜13）
  dl_services_card: dl('サービス一覧', false),
  consult_services_banner: consult('サービス一覧'),
  // サービス詳細・受託開発（14〜16）
  consult_development_hero: consult('受託開発'),
  consult_development_card: consult('受託開発'),
  consult_development_banner: consult('受託開発'),
  // サービス詳細・環境構築（§4.3.4）
  consult_environment_setup_hero: consult('環境構築'),
  consult_environment_setup_card: consult('環境構築'),
  dl_environment_setup_card: dl('環境構築', false),
  consult_environment_setup_banner: consult('環境構築'),
  // サービス詳細・コンサル（§4.3.4）
  consult_consulting_hero: consult('コンサル'),
  consult_consulting_card: consult('コンサル'),
  consult_consulting_banner: consult('コンサル'),
  // サービス詳細・業務提携（§4.3.4）
  consult_partnership_hero: consult('業務提携'),
  consult_partnership_card: consult('業務提携'),
  consult_partnership_banner: consult('業務提携'),
  // 料金（17〜20）
  consult_pricing_card: consult('料金'),
  dl_pricing_card: dl('料金', false),
  consult_pricing_banner: consult('料金'),
  // 会社概要（21）
  consult_about_banner: consult('会社概要'),
  // 無料相談（22〜24）。フォームはボタンではないので cta_viewed を送らない（form_* を送る）
  consult_contact_form: consult('無料相談', false),
  chat_contact_aside: { ctaType: 'chat', ctaRole: 'assist', trackView: false, screen: '無料相談' },
  dl_contact_aside: dl('無料相談', false),
  // 完了（25・25'）。予約枠は cta_viewed の代わりに booking_viewed を送る（§6.3 の注）
  dl_thanks_card: dl('完了', false),
  booking_thanks_embed: { ctaType: 'booking', ctaRole: 'primary', trackView: false, screen: '完了' },
  // ブログ一覧（26）
  dl_blog_section: dl('ブログ一覧', true, 'primary'),
  // ブログ記事（27〜31）。dl_article_end は顕在の記事で secondary に変わる（§6.3 の注）
  dl_article_inline: dl('ブログ記事', true, 'primary'),
  dl_article_end: dl('ブログ記事', true, 'primary'),
  consult_article_inline: consult('ブログ記事'),
  consult_article_end: consult('ブログ記事'),
} as const satisfies Record<string, CtaDefinition>;

export type CtaId = keyof typeof CTAS;

export function isCtaId(value: string): value is CtaId {
  return Object.hasOwn(CTAS, value);
}

/** 相談の対象のサービス（DD-02 の 5.3 の service_interest。6 種に限る） */
export const SERVICE_INTERESTS = [
  'environment-setup',
  'development',
  'development-vibe',
  'development-full',
  'consulting',
  'partnership',
] as const;
export type ServiceInterest = (typeof SERVICE_INTERESTS)[number];

export function isServiceInterest(value: string): value is ServiceInterest {
  return (SERVICE_INTERESTS as readonly string[]).includes(value);
}

/**
 * CTA の要素に付ける data 属性。analytics の CtaTracking がこれを拾う。
 * role・trackView を省いたら一覧の既定値を使う。
 */
export function ctaDataAttributes(
  ctaId: CtaId,
  options: { ctaRole?: CtaRole; service?: ServiceInterest; trackView?: boolean } = {},
): Record<string, string> {
  const def: CtaDefinition = CTAS[ctaId];
  const attrs: Record<string, string> = {
    'data-cta-id': ctaId,
    'data-cta-type': def.ctaType,
    'data-cta-role': options.ctaRole ?? def.ctaRole,
  };
  if (options.service) attrs['data-cta-service'] = options.service;
  if (!(options.trackView ?? def.trackView)) attrs['data-cta-view'] = 'false';
  return attrs;
}

/**
 * 無料相談（/contact）へのリンク。?cta= と ?from= はフォームの hidden（cta_id・page_url）に渡す（§5.1・§6.3）。
 * from は CTA を押したページのパス（ビルド時の Astro.url.pathname）。
 */
export function contactHref({ cta, from, service }: { cta: CtaId; from: string; service?: ServiceInterest }): string {
  const params = new URLSearchParams();
  if (service) params.set('service', service);
  params.set('cta', cta);
  params.set('from', from);
  return `/contact?${params.toString()}`;
}
