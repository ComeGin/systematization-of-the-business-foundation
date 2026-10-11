// PostHog（DD-02 の 3 節）。同意の後にだけ posthog-js を動的に読み込んで init する（未同意のあいだは読み込みもしない）。
// PUBLIC_POSTHOG_PROJECT_TOKEN が未設定なら何もしない。
// - セッションリプレイは無効（入力欄のマスキングを先に入れる決まり。3.1）
// - autocapture・dead clicks・ヒートマップ・アンケート・会話・プロダクトツアーは無効（送るイベントは §6.2 の一覧だけ）
// - capture_performance は指定しない（プロジェクトの設定に従い、$web_vitals を取る。3.5）
// - 例外は capture_exceptions で送る（用途の「例外の監視」。ADR-25）
import type { PostHog } from 'posthog-js';
import { getConsent } from '@/modules/consent/client';

let loading: Promise<PostHog | null> | null = null;
let instance: PostHog | null = null;

export function grantPosthog(): Promise<PostHog | null> {
  const token = import.meta.env.PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!token) return Promise.resolve(null);
  if (instance) {
    if (instance.has_opted_out_capturing()) instance.opt_in_capturing();
    return Promise.resolve(instance);
  }
  loading ??= import('posthog-js')
    .then(({ default: posthog }) => {
      if (getConsent() !== 'granted') return null;
      posthog.init(token, {
        api_host: import.meta.env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
        defaults: '2026-05-30',
        autocapture: false,
        disable_session_recording: true,
        capture_exceptions: true,
        // プロジェクトの設定（リモート）で有効でも読み込まない。用途は 4 つに限る（ADR-25）
        capture_dead_clicks: false,
        capture_heatmaps: false,
        disable_surveys: true,
        disable_conversations: true,
        disable_product_tours: true,
        // 撤回の後に、撤回の前に取ったイベントがまとめ送りの残りとして出ないようにする。
        // posthog-js には送信待ちのキューを捨てる公開の API が無いため、まとめ送りをやめて取ったらすぐ送る。
        request_batching: false,
        // 念のため、送る直前にも同意を確かめる（撤回と送信が競ったときに捨てる）
        before_send: (event) => (getConsent() === 'granted' ? event : null),
      });
      // 過去に撤回していた訪問者が同意し直した場合
      if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
      instance = posthog;
      return posthog;
    })
    .catch(() => {
      // 読み込みの失敗はサイトの表示に影響させない（DD-02 の 3 節「失敗時は何もしない」）
      loading = null;
      return null;
    });
  return loading;
}

/** 撤回（DD-02 の 3.4 の 1・2）。送信を止め、distinct_id を切る */
export function revokePosthog(): void {
  if (!instance) return;
  instance.opt_out_capturing();
  instance.reset();
}

/**
 * イベントを送る。同意が無いときは捨てる（溜めて後から送らない。DD-02 の 3.2）。
 * 同意の後で posthog-js の読み込みが終わっていないときだけ、読み込みを待って送る。
 */
export function track(event: string, properties: Record<string, unknown>, options: { beacon?: boolean } = {}): void {
  if (getConsent() !== 'granted') return;
  const send = (posthog: PostHog | null) => {
    if (!posthog || getConsent() !== 'granted') return;
    posthog.capture(event, properties, options.beacon ? { transport: 'sendBeacon' } : undefined);
  };
  if (instance) send(instance);
  else if (loading) void loading.then(send);
}

/** フォームの hidden の distinct_id（同意した訪問者だけ。DD-02 の 5.3） */
export function getDistinctId(): string {
  if (!instance || getConsent() !== 'granted') return '';
  return instance.get_distinct_id() ?? '';
}
