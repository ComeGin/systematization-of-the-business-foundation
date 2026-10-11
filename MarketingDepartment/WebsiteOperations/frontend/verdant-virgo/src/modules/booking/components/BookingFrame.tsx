// 予約枠（Cal.com の埋め込み）と、読み込みに失敗したときの代わりの案内（01-content-spec.md §4.6 の 6'-2）。
// 予約枠は同意の対象にしない（§8.2.1。同意していない訪問者にも出す）が、booking_* のイベントは同意の後にだけ送る（§6.2）。
// 失敗の判定: embed.js の読み込みエラー、linkFailed、15 秒たっても埋め込みから何の通知も来ない。PUBLIC_CALCOM_LINK が未設定なら最初から代わりの案内。
import { useEffect, useId, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { track } from '@/modules/analytics/client';
import { loadCalNamespace } from '../lib/calcom';
import { BOOKING_TEXT } from '../lib/messages';

const READY_TIMEOUT_MS = 15_000;

type State = 'loading' | 'ready' | 'failed';

function bookingProperties() {
  return { cta_id: 'booking_thanks_embed', cta_type: 'booking', cta_role: 'primary', page_path: location.pathname };
}

export default function BookingFrame() {
  const frameId = `cal-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const frameRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    const base = import.meta.env.PUBLIC_CALCOM_BASE?.replace(/\/$/, '');
    const calLink = import.meta.env.PUBLIC_CALCOM_LINK;
    if (!base || !calLink) {
      console.warn('[booking] PUBLIC_CALCOM_BASE か PUBLIC_CALCOM_LINK が未設定のため、予約枠の代わりの案内を出します。');
      setState('failed');
      return;
    }
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      setState('failed');
    };
    const timer = window.setTimeout(fail, READY_TIMEOUT_MS);
    const cal = loadCalNamespace(base, fail);
    const brand = getComputedStyle(document.documentElement).getPropertyValue('--color-role-surface-brand').trim();
    cal('inline', { elementOrSelector: `#${frameId}`, calLink, config: { layout: 'month_view' } });
    cal('ui', { theme: 'light', hideEventTypeDetails: false, ...(brand ? { cssVarsPerTheme: { light: { 'cal-brand': brand } } } : {}) });
    // linkFailed 以外の通知（linkReady・bookerReady・内部の __iframeReady など）が 1 つでも来たら、枠は動いていると見なす。
    // linkReady だけを待つと、名前の変更などで来なかったときに、動いている予約枠を代わりの案内で消してしまうため
    cal('on', {
      action: '*',
      callback: (event: CustomEvent<{ type?: string }>) => {
        if (event.detail?.type === 'linkFailed') return fail();
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        setState('ready');
      },
    });
    // 予約の完了。氏名・メールアドレス・日時は受け取っても送らない（§6.2）
    cal('on', { action: 'bookingSuccessfulV2', callback: () => track('booking_scheduled', bookingProperties()) });
    return () => window.clearTimeout(timer);
  }, [frameId]);

  // 予約枠が画面に 50% 以上入ったとき（1 ページの表示につき 1 回）
  useEffect(() => {
    const element = frameRef.current;
    if (!element || state === 'failed') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        track('booking_viewed', bookingProperties());
      },
      { threshold: 0.5 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [state === 'failed']);

  if (state === 'failed') {
    return (
      <Alert>
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{BOOKING_TEXT.failedTitle}</AlertTitle>
        <AlertDescription>{BOOKING_TEXT.failedBody}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div ref={frameRef} className="relative h-[560px] w-full overflow-auto rounded-lg border border-border bg-card md:h-[640px]">
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <Spinner className="size-6" />
        </div>
      )}
      <div id={frameId} className="h-full w-full" />
    </div>
  );
}
