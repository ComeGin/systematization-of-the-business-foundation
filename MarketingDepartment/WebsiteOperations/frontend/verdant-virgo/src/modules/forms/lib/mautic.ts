// Mautic のフォームへの送信（I-08。DD-02 の 5 節）。
// 受け口: POST ${PUBLIC_MAUTIC_BASE}/form/submit?formId=<id>&ajax=1
//   本文は application/x-www-form-urlencoded の mauticform[...]（CORS のプリフライトが起きない形）。
//   ajax=1 と mauticform[messenger]=1 で、Mautic は JSON {success, validationErrors?, errorMessage?} を返す
//   （backend/mautic-system の FormBundle/Controller/PublicController.php の createSubmitContext・buildMessengerResponse）。
// 同期・タイムアウト 10 秒・自動の再送なし。失敗は呼び出し側が利用者に明示する。
// 応答を読むには Mautic 側で公開サイトのオリジンからの CORS を許す必要がある（読めないと network に分類される）。
// ⚠ urlencoded の単純なリクエストはプリフライトが起きないので、CORS が無くても POST 自体は Mautic に届いて処理される。
//   その場合、画面は「送信できませんでした」を出し、利用者が押し直すと二重に登録される（失敗時は二重送信の記録を消すため。
//   DD-02 の 5.2）。二重登録は CV の数え方（mautic_form_id ＋ lower(email) ＋ 日付で畳む。5.4）で吸収する。
//   CORS の許可は公開の前に必須（03-handoff の申し送り）。

export type SubmitErrorKind = "timeout" | "network" | "http_4xx" | "http_5xx";
export type SubmitOutcome = { ok: true } | { ok: false; kind: SubmitErrorKind };

const TIMEOUT_MS = 10_000;

export async function submitToMautic(
  formId: number,
  formName: "consult" | "source_dl",
  fields: Record<string, string>,
): Promise<SubmitOutcome> {
  const base = import.meta.env.PUBLIC_MAUTIC_BASE?.replace(/\/$/, "");
  if (!base) {
    console.error("[forms] PUBLIC_MAUTIC_BASE が未設定のため送信できません。");
    return { ok: false, kind: "network" };
  }

  const body = new URLSearchParams();
  body.set("mauticform[formId]", String(formId));
  body.set("mauticform[formName]", formName);
  body.set("mauticform[messenger]", "1");
  body.set("mauticform[return]", "");
  for (const [alias, value] of Object.entries(fields))
    body.set(`mauticform[${alias}]`, value);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(
      `${base}/form/submit?formId=${formId}&ajax=1`,
      {
        method: "POST",
        body,
        credentials: "omit",
        signal: controller.signal,
      },
    );
    if (response.status >= 500) return { ok: false, kind: "http_5xx" };
    if (response.status >= 400) return { ok: false, kind: "http_4xx" };
    const data = (await response.json().catch(() => null)) as {
      success?: number | boolean;
      validationErrors?: Record<string, unknown>;
    } | null;
    if (data?.success === 1 || data?.success === true) return { ok: true };
    // Mautic が入力を受け付けなかった（項目名だけを出す。値は出さない）
    console.warn(
      "[forms] Mautic が送信を受け付けませんでした。",
      Object.keys(data?.validationErrors ?? {}),
    );
    return { ok: false, kind: "http_4xx" };
  } catch {
    return {
      ok: false,
      kind: controller.signal.aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timer);
  }
}
