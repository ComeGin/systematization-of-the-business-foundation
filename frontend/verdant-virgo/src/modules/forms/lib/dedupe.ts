// 二重送信の防止（冪等性の第 1 層。DD-02 の 5.2、計画書 P-7）。
// キーは mautic_form_id + lower(email) + JST の日付。sessionStorage に置く（同じタブの間だけ）。
// 送信の前に記録し、失敗したら消す（消さないと、失敗したのに送信済みと見なされて二度と送れなくなる）。
import { jstDate } from './jst';

const key = (formId: number, email: string) => `comegin:form-sent:${formId}:${email.toLowerCase()}:${jstDate()}`;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // プライベートモードなどで使えないときは、この層を諦める（送信は止めない）
  }
}

export function wasSentToday(formId: number, email: string): boolean {
  return storage()?.getItem(key(formId, email)) != null;
}

export function markSent(formId: number, email: string): void {
  storage()?.setItem(key(formId, email), '1');
}

export function unmarkSent(formId: number, email: string): void {
  storage()?.removeItem(key(formId, email));
}
