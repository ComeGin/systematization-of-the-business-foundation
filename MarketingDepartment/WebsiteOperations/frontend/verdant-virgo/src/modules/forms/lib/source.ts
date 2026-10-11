// フォームの hidden の値の出どころ（01-content-spec.md §5.1・§5.2、DD-02 の 5.3）。
import { isCtaId, isServiceInterest, type CtaId, type ServiceInterest } from '@/modules/site-content/cta';

/** 同じオリジンのパスだけを受け付ける（//evil.example のようなものは捨てる） */
function samePath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value.split(/[?#]/)[0];
}

/**
 * 無料相談フォームの page_url。CTA を押したページのパス（?from=）。無ければ同じオリジンの referrer、
 * それも無ければ /contact（location をそのまま入れない。DD-02 の 5.3）。
 */
export function consultPageUrl(): string {
  const from = samePath(new URLSearchParams(location.search).get('from'));
  if (from) return from;
  try {
    if (document.referrer) {
      const referrer = new URL(document.referrer);
      if (referrer.origin === location.origin) return referrer.pathname;
    }
  } catch {
    // referrer が URL として読めないときは無視する
  }
  return '/contact';
}

/** ?cta= の値。一覧に無い値は送らない（任意の項目。DD-02 の 5.3） */
export function consultSourceCta(): CtaId | null {
  const value = new URLSearchParams(location.search).get('cta');
  return value && isCtaId(value) ? value : null;
}

/** ?service= の値。6 種の外は送らない */
export function consultServiceInterest(): ServiceInterest | null {
  const value = new URLSearchParams(location.search).get('service');
  return value && isServiceInterest(value) ? value : null;
}
