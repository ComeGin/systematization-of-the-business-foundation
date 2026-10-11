// cta_viewed / cta_clicked（01-content-spec.md §6.2・§6.3）。
// CTA の要素は data-cta-id・data-cta-type・data-cta-role（・data-cta-service）を持つ（site-content/cta.ts の ctaDataAttributes）。
// - cta_viewed: 要素が 50% 以上画面に入ったとき。1 ページの表示につき 1 つの CTA（cta_id ＋ service）で 1 回。
//   data-cta-view="false" の要素は送らない（§6.3 のイベントの列に cta_viewed が無い行）。
// - cta_clicked: 押したとき。data-cta-click="false" の要素（無料 DL ブロックのように form_* を送るもの）は送らない。
// どちらも同意が無ければ送らない。観測は同意の後に始め、撤回で止める（同意前の表示を溜めて後から送らない）。
import { track } from './posthog';

const SELECTOR = '[data-cta-id]';
const viewed = new Set<string>();
let intersection: IntersectionObserver | null = null;
let mutation: MutationObserver | null = null;

function ctaProperties(element: HTMLElement): Record<string, string> {
  const { ctaId = '', ctaType = '', ctaRole = '', ctaService } = element.dataset;
  const properties: Record<string, string> = {
    cta_id: ctaId,
    cta_type: ctaType,
    cta_role: ctaRole,
    page_path: location.pathname,
  };
  if (ctaService) properties.service = ctaService;
  return properties;
}

function observe(element: Element): void {
  if (element instanceof HTMLElement && element.dataset.ctaView !== 'false') intersection?.observe(element);
}

function observeTree(root: ParentNode): void {
  if (root instanceof Element && root.matches(SELECTOR)) observe(root);
  root.querySelectorAll(SELECTOR).forEach(observe);
}

export function startCtaViewTracking(): void {
  if (intersection) return;
  intersection = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target as HTMLElement;
        intersection?.unobserve(element);
        const key = `${element.dataset.ctaId}|${element.dataset.ctaService ?? ''}`;
        if (viewed.has(key)) continue;
        viewed.add(key);
        track('cta_viewed', ctaProperties(element));
      }
    },
    { threshold: 0.5 },
  );
  observeTree(document);
  // Mobile の Sheet のように後から描かれる CTA も拾う
  mutation = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach((node) => node instanceof Element && observeTree(node));
  });
  mutation.observe(document.body, { childList: true, subtree: true });
}

export function stopCtaViewTracking(): void {
  intersection?.disconnect();
  mutation?.disconnect();
  intersection = null;
  mutation = null;
}

export function installCtaClickTracking(): void {
  document.addEventListener(
    'click',
    (event) => {
      const element = (event.target as Element | null)?.closest<HTMLElement>(SELECTOR);
      if (!element || element.dataset.ctaClick === 'false') return;
      // ページ遷移で送信が途切れないよう sendBeacon で送る
      track('cta_clicked', { ...ctaProperties(element), destination: element.getAttribute('href') ?? '' }, { beacon: true });
    },
    { capture: true },
  );
}
