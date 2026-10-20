// 無料相談フォーム（01-content-spec.md §5.1。状態は 通常／入力エラー／送信中／送信失敗〈エラー応答・10 秒の無応答〉／二重送信／成功）。
// 成功したら /contact/thanks に遷移する。失敗しても入力は残し、ボタンを押せる状態に戻す。
// 検証は各欄のフォーカスが外れたときと送信のとき。送信時にエラーがあれば最初のエラー項目にフォーカスを移す。
//
// 読み上げは各状態で 1 回にそろえる（04-accessibility-spec.md §3.6）。
// - 入力エラー: 最初のエラー欄へフォーカス（欄の名前・invalid・エラー文が読まれる）。上の要約は見た目の文で、live region にしない
// - 送信中: ボタンの外の SendStatusAnnouncer（role="status"）が「送信中…」を 1 回読む。ボタンの中の形（SendStatusMark）は読ませない
// - 送信失敗・二重送信: Alert へフォーカス。Alert は role="group" で見出しと本文を名前・説明にする（role="alert" とフォーカスで 2 回読まれるのを防ぐ）
// - 成功: 遷移先の h1 に任せる（完了の文は読ませない。§12 の S-17）
// 状態は根の data-form-state に出す（e2e が見る）。
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { CircleAlert, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { getDistinctId } from "@/modules/analytics/client";
import { SendStatusAnnouncer, SendStatusMark } from "@/modules/motion/client";
import { CONSULT_TEXT } from "../lib/messages";
import {
  charCount,
  validateCompany,
  validateEmail,
  validateFirstname,
  validateLastname,
  validateMessage,
  validatePrivacy,
  pickEmployeeRange,
  pickItDepartment,
} from "../lib/validate";
import { submitToMautic } from "../lib/mautic";
import { markSent, unmarkSent, wasSentToday } from "../lib/dedupe";
import { jstIsoString } from "../lib/jst";
import { createFormEvents, dispatchFormSuccess } from "../lib/events";
import {
  consultPageUrl,
  consultServiceInterest,
  consultSourceCta,
} from "../lib/source";
import FormField from "./FormField";
import ConsentCheckbox from "./ConsentCheckbox";
import CheckboxField from "./CheckboxField";

type FieldName =
  "company" | "lastname" | "firstname" | "email" | "message" | "privacy";
type Errors = Partial<Record<FieldName, string>>;
type Status = "idle" | "submitting" | "failed" | "timeout" | "duplicate";

/** フォーカスを移す順（画面の上から） */
const FIELD_ORDER: FieldName[] = [
  "company",
  "lastname",
  "firstname",
  "email",
  "message",
  "privacy",
];

/** ご相談内容の上限と、文字数を読み上げ始める残りの字数（§12 の S-18） */
const MESSAGE_LIMIT = 2000;
const MESSAGE_ANNOUNCE_REMAINING = 20;

interface ContactFormProps {
  /** MAUTIC_FORM_ID_CONSULT（ビルド時に .astro が読んで渡す。未設定なら null で、送信は失敗として表示する） */
  formId: number | null;
  /** CONSENT_POLICY_VERSION（privacy_consent_version に送る） */
  policyVersion: string;
  /** フォームの名前にする見出しの id（/contact の h1。新しい文言を足さない） */
  labelledBy: string;
}

export default function ContactForm({
  formId,
  policyVersion,
  labelledBy,
}: ContactFormProps) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const events = useMemo(
    () => createFormEvents("consult", formId, "consult_contact_form"),
    [formId],
  );

  const [company, setCompany] = useState("");
  const [employeeRange, setEmployeeRange] = useState("");
  const [itDepartment, setItDepartment] = useState("");
  const [lastname, setLastname] = useState("");
  const [firstname, setFirstname] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [privacy, setPrivacy] = useState(false);
  // お知らせメールの受信の希望（任意。初期値はチェックなし。§5.1 の項目 8）
  const [optin, setOptin] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [showSummary, setShowSummary] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  // 水和の前は送信ボタンを押せなくする。押せると、ブラウザが JS 抜きの素のフォームとして送ってしまう（Mautic には届かず入力が消える）
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const refs = useRef<Partial<Record<FieldName, HTMLElement | null>>>({});
  const alertRef = useRef<HTMLDivElement>(null);

  const validators: Record<FieldName, () => string | null> = {
    company: () => validateCompany(company),
    lastname: () => validateLastname(lastname),
    firstname: () => validateFirstname(firstname),
    email: () => validateEmail(email),
    message: () => validateMessage(message),
    privacy: () => validatePrivacy(privacy),
  };

  /** エラーが出ている欄は、入力のたびに検証し直してエラーを消す（直したのに赤字が残らないように） */
  const revalidate = (name: FieldName, error: string | null) => {
    if (!errors[name]) return;
    setErrors((prev) => {
      const next = { ...prev };
      if (error) next[name] = error;
      else delete next[name];
      return next;
    });
  };

  const validateOne = (name: FieldName) => {
    const error = validators[name]();
    setErrors((prev) => {
      const next = { ...prev };
      if (error) next[name] = error;
      else delete next[name];
      return next;
    });
  };

  useEffect(() => {
    if (status === "failed" || status === "timeout" || status === "duplicate")
      alertRef.current?.focus();
  }, [status]);

  const submitting = status === "submitting";
  const hasErrors = Object.keys(errors).length > 0;

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const found: Errors = {};
    for (const name of FIELD_ORDER) {
      const error = validators[name]();
      if (error) found[name] = error;
    }
    setErrors(found);
    const invalid = FIELD_ORDER.filter((name) => found[name]);
    if (invalid.length > 0) {
      setShowSummary(true);
      setStatus("idle");
      events.validationFailed(invalid);
      refs.current[invalid[0]]?.focus();
      return;
    }
    setShowSummary(false);

    const normalizedEmail = email.trim().toLowerCase();
    if (formId === null) {
      console.error(
        "[forms] MAUTIC_FORM_ID_CONSULT が未設定のため送信できません。",
      );
      setStatus("failed");
      return;
    }
    if (wasSentToday(formId, normalizedEmail)) {
      setStatus("duplicate");
      events.failed("duplicate");
      return;
    }

    setStatus("submitting");
    markSent(formId, normalizedEmail);
    const fields: Record<string, string> = {
      company: company.trim(),
      lastname: lastname.trim(),
      firstname: firstname.trim(),
      email: normalizedEmail,
      message,
      privacy_consent_at: jstIsoString(),
      privacy_consent_version: policyVersion,
      email_optin: optin ? "1" : "0",
      page_url: consultPageUrl(),
    };
    // 任意の項目は、選択肢の中の値があるときだけ送る（未選択・選択肢の外は送らない。§5.1）
    const employee = pickEmployeeRange(employeeRange);
    if (employee) fields.employee_range = employee;
    const itDept = pickItDepartment(itDepartment);
    if (itDept) fields.has_it_department = itDept;
    const sourceCta = consultSourceCta();
    if (sourceCta) fields.cta_id = sourceCta;
    const service = consultServiceInterest();
    if (service) fields.service_interest = service;
    const distinctId = getDistinctId();
    if (distinctId) fields.distinct_id = distinctId;

    const outcome = await submitToMautic(formId, "consult", fields);
    if (outcome.ok) {
      events.submitted();
      dispatchFormSuccess("consult");
      window.location.assign("/contact/thanks");
      return;
    }
    unmarkSent(formId, normalizedEmail);
    events.failed(outcome.kind);
    setStatus(outcome.kind === "timeout" ? "timeout" : "failed");
  };

  const describedBy = (...ids: (string | false | undefined)[]) =>
    ids.filter(Boolean).join(" ") || undefined;
  const errorProps = (name: FieldName) => ({
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": errors[name] ? id(`${name}-error`) : undefined,
  });

  // 文字数: 見える表示は欄の説明として読ませ（フォーカスしたとき）、入力中は残り 20 字以下と超過のときだけ読み上げる（S-18）
  const messageCount = charCount(message);
  const messageCountText = `${messageCount.toLocaleString("ja-JP")} / ${MESSAGE_LIMIT.toLocaleString("ja-JP")}`;
  const announceCount =
    MESSAGE_LIMIT - messageCount <= MESSAGE_ANNOUNCE_REMAINING;

  const formState = submitting
    ? "submitting"
    : status !== "idle"
      ? status
      : showSummary && hasErrors
        ? "invalid"
        : "idle";

  return (
    <form
      method="post"
      noValidate
      aria-labelledby={labelledBy}
      data-form-state={formState}
      onSubmit={onSubmit}
      onFocusCapture={() => events.started()}
      className="grid gap-6"
    >
      <fieldset disabled={submitting} className="grid gap-6">
        <FormField
          label={CONSULT_TEXT.companyLabel}
          requirement="required"
          htmlFor={id("company")}
          error={errors.company}
          errorId={id("company-error")}
        >
          <Input
            id={id("company")}
            ref={(el) => {
              refs.current.company = el;
            }}
            name="company"
            autoComplete="organization"
            required
            value={company}
            onChange={(e) => {
              setCompany(e.target.value);
              revalidate("company", validateCompany(e.target.value));
            }}
            onBlur={() => validateOne("company")}
            {...errorProps("company")}
          />
        </FormField>

        <FormField
          label={CONSULT_TEXT.employeeLabel}
          requirement="optional"
          htmlFor={id("employee")}
        >
          <NativeSelect
            id={id("employee")}
            name="employee_range"
            value={employeeRange}
            onChange={(e) => setEmployeeRange(e.target.value)}
            className="w-full"
          >
            <NativeSelectOption value="">
              {CONSULT_TEXT.employeePlaceholder}
            </NativeSelectOption>
            {CONSULT_TEXT.employeeOptions.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>

        <FormField
          label={CONSULT_TEXT.itDepartmentLabel}
          requirement="optional"
          group
        >
          <RadioGroup
            value={itDepartment}
            onValueChange={(value) => setItDepartment(String(value))}
            className="flex flex-wrap gap-x-6 gap-y-2"
          >
            {CONSULT_TEXT.itDepartmentOptions.map((option) => (
              <label
                key={option.value}
                className="flex items-center gap-2 text-sm"
              >
                {/* span の role=radio は label から名前を受け取れないので、HTML の時点から aria-labelledby で文字を指す */}
                <RadioGroupItem
                  value={option.value}
                  aria-labelledby={id(`it-${option.value}`)}
                />
                <span id={id(`it-${option.value}`)}>{option.label}</span>
              </label>
            ))}
          </RadioGroup>
        </FormField>

        {/* 氏名: まとめのラベル（legend）の下に、姓・名それぞれの見えるラベル・入力欄・エラー文を 2 列で並べる（§5.1 の項目 4）。
            エラー文は各欄の下に出し、各欄の aria-describedby で結ぶ（fieldset には結ばない。2 回読まれるため） */}
        <FormField label={CONSULT_TEXT.nameLabel} requirement="required" group>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid content-start gap-1">
              <label
                htmlFor={id("lastname")}
                className="type-small w-fit text-text-body"
              >
                {CONSULT_TEXT.lastnameLabel}
              </label>
              <Input
                id={id("lastname")}
                ref={(el) => {
                  refs.current.lastname = el;
                }}
                name="lastname"
                autoComplete="family-name"
                required
                value={lastname}
                onChange={(e) => {
                  setLastname(e.target.value);
                  revalidate("lastname", validateLastname(e.target.value));
                }}
                onBlur={() => validateOne("lastname")}
                {...errorProps("lastname")}
              />
              {errors.lastname && (
                <p
                  id={id("lastname-error")}
                  className="phrase text-sm text-destructive"
                >
                  {errors.lastname}
                </p>
              )}
            </div>
            <div className="grid content-start gap-1">
              <label
                htmlFor={id("firstname")}
                className="type-small w-fit text-text-body"
              >
                {CONSULT_TEXT.firstnameLabel}
              </label>
              <Input
                id={id("firstname")}
                ref={(el) => {
                  refs.current.firstname = el;
                }}
                name="firstname"
                autoComplete="given-name"
                required
                value={firstname}
                onChange={(e) => {
                  setFirstname(e.target.value);
                  revalidate("firstname", validateFirstname(e.target.value));
                }}
                onBlur={() => validateOne("firstname")}
                {...errorProps("firstname")}
              />
              {errors.firstname && (
                <p
                  id={id("firstname-error")}
                  className="phrase text-sm text-destructive"
                >
                  {errors.firstname}
                </p>
              )}
            </div>
          </div>
        </FormField>

        <FormField
          label={CONSULT_TEXT.emailLabel}
          requirement="required"
          htmlFor={id("email")}
          helper={CONSULT_TEXT.emailHelper}
          helperId={id("email-helper")}
          error={errors.email}
          errorId={id("email-error")}
        >
          <Input
            id={id("email")}
            ref={(el) => {
              refs.current.email = el;
            }}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            required
            placeholder={CONSULT_TEXT.emailPlaceholder}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              revalidate("email", validateEmail(e.target.value));
            }}
            onBlur={() => validateOne("email")}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={describedBy(
              id("email-helper"),
              errors.email && id("email-error"),
            )}
          />
        </FormField>

        <FormField
          label={CONSULT_TEXT.messageLabel}
          requirement="required"
          htmlFor={id("message")}
          error={errors.message}
          errorId={id("message-error")}
          aside={<span id={id("message-count")}>{messageCountText}</span>}
        >
          <Textarea
            id={id("message")}
            ref={(el) => {
              refs.current.message = el;
            }}
            name="message"
            rows={6}
            required
            // 部品の既定（field-sizing: content・min-h-16）では 6 行分にならないので、Figma の高さ（約 150px）を 8pt の 152px で確保する。長文はそこから伸びる
            className="min-h-38"
            placeholder={CONSULT_TEXT.messagePlaceholder}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              revalidate("message", validateMessage(e.target.value));
            }}
            onBlur={() => validateOne("message")}
            aria-invalid={errors.message ? true : undefined}
            aria-describedby={describedBy(
              id("message-count"),
              errors.message && id("message-error"),
            )}
          />
          {/* live region は先に置き、文字は残り 20 字以下と超過のときだけ入れる */}
          <span role="status" className="sr-only">
            {announceCount ? messageCountText : ""}
          </span>
        </FormField>

        <ConsentCheckbox
          id={id("privacy")}
          checkboxRef={(el) => {
            refs.current.privacy = el;
          }}
          checked={privacy}
          onCheckedChange={(checked) => {
            setPrivacy(checked);
            if (checked) setErrors(({ privacy: _removed, ...rest }) => rest);
          }}
          onBlur={() => validateOne("privacy")}
          error={errors.privacy}
          errorId={id("privacy-error")}
        />

        <CheckboxField
          id={id("optin")}
          label={CONSULT_TEXT.optinLabel}
          checked={optin}
          onCheckedChange={setOptin}
        />
      </fieldset>

      <div className="grid gap-4">
        {showSummary && hasErrors && (
          <p className="phrase text-sm text-destructive">
            {CONSULT_TEXT.errorSummary}
          </p>
        )}
        {(status === "failed" || status === "timeout") && (
          <Alert
            variant="destructive"
            ref={alertRef}
            tabIndex={-1}
            role="group"
            aria-labelledby={id("alert-title")}
            aria-describedby={id("alert-body")}
          >
            <CircleAlert aria-hidden="true" />
            <AlertTitle id={id("alert-title")}>
              {status === "timeout"
                ? CONSULT_TEXT.timeoutTitle
                : CONSULT_TEXT.failedTitle}
            </AlertTitle>
            <AlertDescription id={id("alert-body")}>
              {CONSULT_TEXT.failedBody}
            </AlertDescription>
          </Alert>
        )}
        {status === "duplicate" && (
          <Alert
            ref={alertRef}
            tabIndex={-1}
            role="group"
            aria-labelledby={id("alert-body")}
          >
            <Info aria-hidden="true" />
            <AlertDescription id={id("alert-body")}>
              {CONSULT_TEXT.duplicateBody}
            </AlertDescription>
          </Alert>
        )}
        <SendStatusAnnouncer
          state={submitting ? "sending" : "idle"}
          sendingText={CONSULT_TEXT.submitting}
        />
        <Button
          type="submit"
          size="lg"
          disabled={submitting || !hydrated}
          className="h-11 w-full md:h-10"
          aria-describedby={id("note")}
        >
          <SendStatusMark state={submitting ? "sending" : "idle"} />
          {submitting ? CONSULT_TEXT.submitting : CONSULT_TEXT.submit}
        </Button>
        <p id={id("note")} className="phrase text-sm text-muted-foreground">
          {CONSULT_TEXT.noteBelowButton}
        </p>
      </div>
    </form>
  );
}
