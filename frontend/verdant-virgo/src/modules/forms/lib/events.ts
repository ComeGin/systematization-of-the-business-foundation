// フォームの計測イベント（01-content-spec.md §6.2）。PostHog に送る（同意が無ければ analytics 側で捨てる）。
// プロパティにメールアドレス・氏名・会社名・相談内容・任意 2 項目の値を入れない。
import { track } from '@/modules/analytics/client';
import type { CtaId } from '@/modules/site-content/cta';
import type { SubmitErrorKind } from './mautic';

export type FormKey = 'consult' | 'source_dl';

export function createFormEvents(formKey: FormKey, formId: number | null, ctaId: CtaId) {
  const base = () => ({ form_key: formKey, mautic_form_id: formId, cta_id: ctaId, page_path: location.pathname });
  let started = false;
  return {
    /** いずれかの入力欄に初めてフォーカスしたとき（1 回だけ） */
    started() {
      if (started) return;
      started = true;
      track('form_started', base());
    },
    validationFailed(fields: string[]) {
      track('form_validation_failed', { ...base(), fields });
    },
    submitted() {
      track('form_submitted', base());
    },
    failed(errorKind: SubmitErrorKind | 'duplicate') {
      track('form_submit_failed', { ...base(), error_kind: errorKind });
    },
  };
}

/**
 * 送信の成功を document に知らせるイベントの名前（送り手の正本。設計書 §9）。
 * 受け手はアバターの watchTriggers（avatar/lib/triggers.ts に同じ値の定数があり、単体テストで一致を見る）。
 * avatar はこのファイルを import しない（analytics を引き込み、アバターの island が重くなるため）。
 */
export const FORM_SUCCESS_EVENT = 'comegin:form-success';

/** 送信が成功したことを document に出す（forms は avatar を直接呼ばない）。document が無い環境では何もしない */
export function dispatchFormSuccess(formKey: FormKey): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(
    new CustomEvent<{ formKey: FormKey }>(FORM_SUCCESS_EVENT, { detail: { formKey } }),
  );
}
