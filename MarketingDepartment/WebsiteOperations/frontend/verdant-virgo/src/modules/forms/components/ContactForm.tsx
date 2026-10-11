// 無料相談フォーム（01-content-spec.md §5.1。状態は 通常／入力エラー／送信中／送信失敗〈エラー応答・10 秒の無応答〉／二重送信／成功）。
// 成功したら /contact/thanks に遷移する。失敗しても入力は残し、ボタンを押せる状態に戻す。
// 検証は各欄のフォーカスが外れたときと送信のとき。送信時にエラーがあれば最初のエラー項目にフォーカスを移す。
import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { CircleAlert, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { getDistinctId } from '@/modules/analytics/client';
import { CONSULT_TEXT } from '../lib/messages';
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
} from '../lib/validate';
import { submitToMautic } from '../lib/mautic';
import { markSent, unmarkSent, wasSentToday } from '../lib/dedupe';
import { jstIsoString } from '../lib/jst';
import { createFormEvents } from '../lib/events';
import { consultPageUrl, consultServiceInterest, consultSourceCta } from '../lib/source';
import FormField from './FormField';
import ConsentCheckbox from './ConsentCheckbox';

type FieldName = 'company' | 'lastname' | 'firstname' | 'email' | 'message' | 'privacy';
type Errors = Partial<Record<FieldName, string>>;
type Status = 'idle' | 'submitting' | 'failed' | 'timeout' | 'duplicate';

/** フォーカスを移す順（画面の上から） */
const FIELD_ORDER: FieldName[] = ['company', 'lastname', 'firstname', 'email', 'message', 'privacy'];

interface ContactFormProps {
  /** MAUTIC_FORM_ID_CONSULT（ビルド時に .astro が読んで渡す。未設定なら null で、送信は失敗として表示する） */
  formId: number | null;
  /** CONSENT_POLICY_VERSION（privacy_consent_version に送る） */
  policyVersion: string;
}

export default function ContactForm({ formId, policyVersion }: ContactFormProps) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const events = useMemo(() => createFormEvents('consult', formId, 'consult_contact_form'), [formId]);

  const [company, setCompany] = useState('');
  const [employeeRange, setEmployeeRange] = useState('');
  const [itDepartment, setItDepartment] = useState('');
  const [lastname, setLastname] = useState('');
  const [firstname, setFirstname] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [privacy, setPrivacy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [showSummary, setShowSummary] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
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
    if (status === 'failed' || status === 'timeout' || status === 'duplicate') alertRef.current?.focus();
  }, [status]);

  const submitting = status === 'submitting';

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
      setStatus('idle');
      events.validationFailed(invalid);
      refs.current[invalid[0]]?.focus();
      return;
    }
    setShowSummary(false);

    const normalizedEmail = email.trim().toLowerCase();
    if (formId === null) {
      console.error('[forms] MAUTIC_FORM_ID_CONSULT が未設定のため送信できません。');
      setStatus('failed');
      return;
    }
    if (wasSentToday(formId, normalizedEmail)) {
      setStatus('duplicate');
      events.failed('duplicate');
      return;
    }

    setStatus('submitting');
    markSent(formId, normalizedEmail);
    const fields: Record<string, string> = {
      company: company.trim(),
      lastname: lastname.trim(),
      firstname: firstname.trim(),
      email: normalizedEmail,
      message,
      privacy_consent_at: jstIsoString(),
      privacy_consent_version: policyVersion,
      email_optin: '0',
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

    const outcome = await submitToMautic(formId, 'consult', fields);
    if (outcome.ok) {
      events.submitted();
      window.location.assign('/contact/thanks');
      return;
    }
    unmarkSent(formId, normalizedEmail);
    events.failed(outcome.kind);
    setStatus(outcome.kind === 'timeout' ? 'timeout' : 'failed');
  };

  const errorProps = (name: FieldName) => ({
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? id(`${name}-error`) : undefined,
  });

  return (
    <form method="post" noValidate onSubmit={onSubmit} onFocusCapture={() => events.started()} className="grid gap-6">
      <fieldset disabled={submitting} className="grid gap-6">
        <FormField label={CONSULT_TEXT.companyLabel} requirement="required" htmlFor={id('company')} error={errors.company} errorId={id('company-error')}>
          <Input
            id={id('company')}
            ref={(el) => {
              refs.current.company = el;
            }}
            name="company"
            autoComplete="organization"
            value={company}
            onChange={(e) => {
              setCompany(e.target.value);
              revalidate('company', validateCompany(e.target.value));
            }}
            onBlur={() => validateOne('company')}
            {...errorProps('company')}
          />
        </FormField>

        <FormField label={CONSULT_TEXT.employeeLabel} requirement="optional" htmlFor={id('employee')}>
          <NativeSelect id={id('employee')} name="employee_range" value={employeeRange} onChange={(e) => setEmployeeRange(e.target.value)} className="w-full">
            <NativeSelectOption value="">{CONSULT_TEXT.employeePlaceholder}</NativeSelectOption>
            {CONSULT_TEXT.employeeOptions.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>

        <FormField label={CONSULT_TEXT.itDepartmentLabel} requirement="optional" group>
          <RadioGroup value={itDepartment} onValueChange={(value) => setItDepartment(String(value))} className="flex flex-wrap gap-x-6 gap-y-2">
            {CONSULT_TEXT.itDepartmentOptions.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm">
                {/* span の role=radio は label から名前を受け取れないので、HTML の時点から aria-labelledby で文字を指す */}
                <RadioGroupItem value={option.value} aria-labelledby={id(`it-${option.value}`)} />
                <span id={id(`it-${option.value}`)}>{option.label}</span>
              </label>
            ))}
          </RadioGroup>
        </FormField>

        <FormField
          label={CONSULT_TEXT.nameLabel}
          requirement="required"
          group
          error={errors.lastname ?? errors.firstname}
          errorId={id(errors.lastname ? 'lastname-error' : 'firstname-error')}
        >
          <div className="grid grid-cols-2 gap-2">
            <Input
              id={id('lastname')}
              ref={(el) => {
                refs.current.lastname = el;
              }}
              name="lastname"
              autoComplete="family-name"
              placeholder={CONSULT_TEXT.lastnamePlaceholder}
              aria-label={CONSULT_TEXT.lastnamePlaceholder}
              value={lastname}
              onChange={(e) => {
                setLastname(e.target.value);
                revalidate('lastname', validateLastname(e.target.value));
              }}
              onBlur={() => validateOne('lastname')}
              {...errorProps('lastname')}
            />
            <Input
              id={id('firstname')}
              ref={(el) => {
                refs.current.firstname = el;
              }}
              name="firstname"
              autoComplete="given-name"
              placeholder={CONSULT_TEXT.firstnamePlaceholder}
              aria-label={CONSULT_TEXT.firstnamePlaceholder}
              value={firstname}
              onChange={(e) => {
                setFirstname(e.target.value);
                revalidate('firstname', validateFirstname(e.target.value));
              }}
              onBlur={() => validateOne('firstname')}
              {...errorProps('firstname')}
            />
          </div>
        </FormField>

        <FormField
          label={CONSULT_TEXT.emailLabel}
          requirement="required"
          htmlFor={id('email')}
          helper={CONSULT_TEXT.emailHelper}
          helperId={id('email-helper')}
          error={errors.email}
          errorId={id('email-error')}
        >
          <Input
            id={id('email')}
            ref={(el) => {
              refs.current.email = el;
            }}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            placeholder={CONSULT_TEXT.emailPlaceholder}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              revalidate('email', validateEmail(e.target.value));
            }}
            onBlur={() => validateOne('email')}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? `${id('email-helper')} ${id('email-error')}` : id('email-helper')}
          />
        </FormField>

        <FormField
          label={CONSULT_TEXT.messageLabel}
          requirement="required"
          htmlFor={id('message')}
          error={errors.message}
          errorId={id('message-error')}
          aside={<span aria-live="polite">{`${charCount(message).toLocaleString('ja-JP')} / 2,000`}</span>}
        >
          <Textarea
            id={id('message')}
            ref={(el) => {
              refs.current.message = el;
            }}
            name="message"
            rows={6}
            // 部品の既定（field-sizing: content・min-h-16）では 6 行分にならないので、Figma の高さ（約 150px）を 8pt の 152px で確保する。長文はそこから伸びる
            className="min-h-38"
            placeholder={CONSULT_TEXT.messagePlaceholder}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              revalidate('message', validateMessage(e.target.value));
            }}
            onBlur={() => validateOne('message')}
            {...errorProps('message')}
          />
        </FormField>

        <ConsentCheckbox
          id={id('privacy')}
          checkboxRef={(el) => {
            refs.current.privacy = el;
          }}
          checked={privacy}
          onCheckedChange={(checked) => {
            setPrivacy(checked);
            if (checked) setErrors(({ privacy: _removed, ...rest }) => rest);
          }}
          onBlur={() => validateOne('privacy')}
          error={errors.privacy}
          errorId={id('privacy-error')}
        />
      </fieldset>

      <div className="grid gap-4">
        {showSummary && Object.keys(errors).length > 0 && (
          <p role="alert" className="phrase text-sm text-destructive">
            {CONSULT_TEXT.errorSummary}
          </p>
        )}
        {(status === 'failed' || status === 'timeout') && (
          <Alert variant="destructive" ref={alertRef} tabIndex={-1}>
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{status === 'timeout' ? CONSULT_TEXT.timeoutTitle : CONSULT_TEXT.failedTitle}</AlertTitle>
            <AlertDescription>{CONSULT_TEXT.failedBody}</AlertDescription>
          </Alert>
        )}
        {status === 'duplicate' && (
          <Alert ref={alertRef} tabIndex={-1}>
            <Info aria-hidden="true" />
            <AlertDescription>{CONSULT_TEXT.duplicateBody}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" size="lg" disabled={submitting || !hydrated} className="h-11 w-full md:h-10" aria-describedby={id('note')}>
          {submitting && <Spinner aria-hidden="true" />}
          {submitting ? CONSULT_TEXT.submitting : CONSULT_TEXT.submit}
        </Button>
        <p id={id('note')} className="phrase text-sm text-muted-foreground">
          {CONSULT_TEXT.noteBelowButton}
        </p>
      </div>
    </form>
  );
}
