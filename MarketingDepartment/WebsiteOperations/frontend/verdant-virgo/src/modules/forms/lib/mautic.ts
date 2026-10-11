// Mautic のフォームへの送信（I-08。DD-02 の 5 節）。
// 受け口: POST ${PUBLIC_MAUTIC_BASE}/form/submit?formId=<id>&ajax=1
//   本文は application/x-www-form-urlencoded の mauticform[...]。
//   ajax=1 と mauticform[messenger]=1 で、Mautic は JSON {success, validationErrors?, errorMessage?} を返す
//   （backend/mautic-system の FormBundle/Controller/PublicController.php の createSubmitContext・buildMessengerResponse）。
// 同期・タイムアウト 10 秒・自動の再送なし。失敗は呼び出し側が利用者に明示する。
// 応答を読むには Mautic 側で公開サイトのオリジンからの CORS を許す必要がある（cors_valid_domains。読めないと network に分類される）。
// X-Requested-With: XMLHttpRequest は必須。Mautic の app/middlewares/CORSMiddleware.php は、この見出しが付いた要求の応答にだけ
//   Access-Control-Allow-Origin を付ける（無いと CORS を許可していても応答を読めない）。
//   この見出しでプリフライト（OPTIONS）が起きるので、CORS の許可が無いオリジンからは POST 自体が送られない
//   （届いたのに「送信できませんでした」になり、押し直しで二重に登録される、ということが起きない）。
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
        headers: { "X-Requested-With": "XMLHttpRequest" },
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
