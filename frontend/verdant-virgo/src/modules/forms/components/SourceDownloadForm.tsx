// 無料 DL ブロックのフォーム側（01-content-spec.md §5.2。状態は 通常／入力エラー／送信中／送信失敗／成功）。
// 成功したらフォームを成功の表示に置き換える（ページ遷移しない）。ブロックの見出し・本文・GitHub のリンクは残る。
// 二重送信（同じブラウザ・同じ日・同じメール）は送らずに成功の表示にする（§5.2 に二重送信の文言が無いため。
// 手順書は先の送信で届いているので、成功の文は事実と食い違わない）。
//
// 読み上げは各状態で 1 回にそろえる（04-accessibility-spec.md §3.6）。
// - 入力エラー: 最初のエラー欄へフォーカス
// - 送信中: ボタンの外の SendStatusAnnouncer（role="status"）が「送信中…」を 1 回読む
// - 送信失敗: Alert へフォーカス（role="group" で見出しと本文を名前・説明にする。role="alert" と重ねない）
// - 成功: ボタンの中の形をチェック（done）にして DURATION.large だけ見せ、成功の表示に切り替えてそこへフォーカス（ここで 1 回読む）。
//   reduced-motion のときは待たずに切り替える。完了の文は足さない（§12 の S-17）
// 状態は根の data-form-state に出す（e2e が見る）。
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useReducedMotion } from "@/modules/a11y/client";
import { getDistinctId } from "@/modules/analytics/client";
import {
  DURATION,
  SendStatusAnnouncer,
  SendStatusMark,
  type SendStatusState,
} from "@/modules/motion/client";
import type { CtaId } from "@/modules/site-content/cta";
import { SOURCE_DL_TEXT } from "../lib/messages";
import { validateEmail, validatePrivacy } from "../lib/validate";
import { submitToMautic } from "../lib/mautic";
import { markSent, unmarkSent, wasSentToday } from "../lib/dedupe";
import { jstIsoString } from "../lib/jst";
import { createFormEvents } from "../lib/events";
import FormField from "./FormField";
import ConsentCheckbox from "./ConsentCheckbox";
import CheckboxField from "./CheckboxField";

type Status = "idle" | "submitting" | "failed" | "done" | "success";

export interface SourceDownloadFormProps {
  /** MAUTIC_FORM_ID_SOURCE_DL（未設定なら null で、送信は失敗として表示する） */
  formId: number | null;
  policyVersion: string;
  /** そのブロックの cta_id（hidden の cta_id とイベントの cta_id） */
  ctaId: CtaId;
  /** 強調版は Primary、控えめ版は Outline（§5.2 のボタン） */
  emphasis: "subtle" | "strong";
  /** フォームの名前にするブロックの見出しの id（新しい文言を足さない） */
  labelledBy: string;
}

export default function SourceDownloadForm({
  formId,
  policyVersion,
  ctaId,
  emphasis,
  labelledBy,
}: SourceDownloadFormProps) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const events = useMemo(
    () => createFormEvents("source_dl", formId, ctaId),
    [formId, ctaId],
  );
  const reducedMotion = useReducedMotion();

  const [email, setEmail] = useState("");
  const [privacy, setPrivacy] = useState(false);
  const [optin, setOptin] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; privacy?: string }>(
    {},
  );
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  // 水和の前は送信ボタンを押せなくする。押せると、ブラウザが JS 抜きの素のフォームとして送ってしまう（Mautic には届かず入力が消える）
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const emailRef = useRef<HTMLInputElement>(null);
  const privacyRef = useRef<HTMLElement | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status === "failed" || status === "success") resultRef.current?.focus();
  }, [status]);

  // 成功のチェックを見せる間（done）だけ待ってから、成功の表示に切り替える
  useEffect(() => {
    if (status !== "done") return;
    const timer = window.setTimeout(() => setStatus("success"), DURATION.large);
    return () => window.clearTimeout(timer);
  }, [status]);

  // 送信中とチェックを見せる間は、入力欄もボタンも触れない
  const busy = status === "submitting" || status === "done";
  const sendState: SendStatusState =
    status === "submitting" ? "sending" : status === "done" ? "done" : "idle";
  const hasErrors = Boolean(errors.email || errors.privacy);

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const found: { email?: string; privacy?: string } = {};
    const emailError = validateEmail(email);
    if (emailError) found.email = emailError;
    const privacyError = validatePrivacy(privacy);
    if (privacyError) found.privacy = privacyError;
    setErrors(found);
    setAttempted(true);
    const invalid = (["email", "privacy"] as const).filter(
      (name) => found[name],
    );
    if (invalid.length > 0) {
      setStatus("idle");
      events.validationFailed([...invalid]);
      (invalid[0] === "email" ? emailRef.current : privacyRef.current)?.focus();
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (formId === null) {
      console.error(
        "[forms] MAUTIC_FORM_ID_SOURCE_DL が未設定のため送信できません。",
      );
      setStatus("failed");
      return;
    }
    if (wasSentToday(formId, normalizedEmail)) {
      events.failed("duplicate");
      setStatus("success");
      return;
    }

    setStatus("submitting");
    markSent(formId, normalizedEmail);
    const fields: Record<string, string> = {
      email: normalizedEmail,
      privacy_consent_at: jstIsoString(),
      privacy_consent_version: policyVersion,
      email_optin: optin ? "1" : "0",
      // 無料 DL は各ページに埋め込むので、そのページのパスをそのまま入れる（§5.2）
      page_url: location.pathname,
      cta_id: ctaId,
    };
    const distinctId = getDistinctId();
    if (distinctId) fields.distinct_id = distinctId;

    const outcome = await submitToMautic(formId, "source_dl", fields);
    if (outcome.ok) {
      events.submitted();
      setStatus(reducedMotion ? "success" : "done");
      return;
    }
    unmarkSent(formId, normalizedEmail);
    events.failed(outcome.kind);
    setStatus("failed");
  };

  if (status === "success") {
    return (
      <div
        ref={resultRef}
        tabIndex={-1}
        role="group"
        aria-labelledby={id("success-title")}
        aria-describedby={id("success-body")}
        data-form-state="success"
        className="grid gap-3 outline-none"
      >
        <CircleCheck aria-hidden="true" className="size-6 text-text-heading" />
        <p
          id={id("success-title")}
          className="phrase text-lg font-bold text-text-heading"
        >
          {SOURCE_DL_TEXT.successTitle}
        </p>
        <p id={id("success-body")} className="phrase text-sm leading-[1.75]">
          {SOURCE_DL_TEXT.successBody}
        </p>
      </div>
    );
  }

  const formState =
    status !== "idle" ? status : attempted && hasErrors ? "invalid" : "idle";

  return (
    <form
      method="post"
      noValidate
      aria-labelledby={labelledBy}
      data-form-state={formState}
      onSubmit={onSubmit}
      onFocusCapture={() => events.started()}
      className="grid gap-4"
    >
      <fieldset disabled={busy} className="grid gap-4">
        <FormField
          label={SOURCE_DL_TEXT.emailLabel}
          requirement="required"
          htmlFor={id("email")}
          error={errors.email}
          errorId={id("email-error")}
        >
          <Input
            id={id("email")}
            ref={emailRef}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            required
            placeholder={SOURCE_DL_TEXT.emailPlaceholder}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (errors.email)
                setErrors((prev) => ({
                  ...prev,
                  email: validateEmail(e.target.value) ?? undefined,
                }));
            }}
            onBlur={() =>
              setErrors((prev) => ({
                ...prev,
                email: validateEmail(email) ?? undefined,
              }))
            }
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? id("email-error") : undefined}
          />
        </FormField>
        <ConsentCheckbox
          id={id("privacy")}
          checkboxRef={privacyRef}
          checked={privacy}
          onCheckedChange={(checked) => {
            setPrivacy(checked);
            if (checked) setErrors((prev) => ({ ...prev, privacy: undefined }));
          }}
          onBlur={() =>
            setErrors((prev) => ({
              ...prev,
              privacy: validatePrivacy(privacy) ?? undefined,
            }))
          }
          error={errors.privacy}
          errorId={id("privacy-error")}
        />
        <CheckboxField
          id={id("optin")}
          label={SOURCE_DL_TEXT.optinLabel}
          checked={optin}
          onCheckedChange={setOptin}
        />
      </fieldset>

      {status === "failed" && (
        <Alert
          variant="destructive"
          ref={resultRef}
          tabIndex={-1}
          role="group"
          aria-labelledby={id("alert-title")}
          aria-describedby={id("alert-body")}
        >
          <CircleAlert aria-hidden="true" />
          <AlertTitle id={id("alert-title")}>
            {SOURCE_DL_TEXT.failedTitle}
          </AlertTitle>
          <AlertDescription id={id("alert-body")}>
            {SOURCE_DL_TEXT.failedBody}
          </AlertDescription>
        </Alert>
      )}
      <SendStatusAnnouncer
        state={sendState}
        sendingText={SOURCE_DL_TEXT.submitting}
      />
      <Button
        type="submit"
        size="lg"
        variant={emphasis === "strong" ? "default" : "outline"}
        disabled={busy || !hydrated}
        className="h-11 w-full md:h-10"
        aria-describedby={id("note")}
      >
        <SendStatusMark state={sendState} />
        {status === "submitting"
          ? SOURCE_DL_TEXT.submitting
          : SOURCE_DL_TEXT.submit}
      </Button>
      <p
        id={id("note")}
        className="phrase text-xs leading-normal tracking-[0.04em] text-muted-foreground"
      >
        {SOURCE_DL_TEXT.noteBelowButton}
      </p>
    </form>
  );
}
