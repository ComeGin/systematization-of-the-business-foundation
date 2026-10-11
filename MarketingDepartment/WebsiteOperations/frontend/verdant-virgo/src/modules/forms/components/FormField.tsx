// 入力欄 1 つ分の枠（ラベル ＋ 必須/任意の Badge ＋ 入力欄 ＋ 補足文 ＋ エラー文）。01-content-spec.md §5.1。
// ラベルだけで必須か任意かが分かるようにする（どちらの印も無い入力欄を作らない。例外は任意のチェックボックス）。
// 複数の入力欄をまとめるもの（氏名の姓・名、ラジオ）は fieldset ＋ legend で出す。
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { BADGE } from '../lib/messages';

export type Requirement = 'required' | 'optional';

export function RequirementBadge({ requirement }: { requirement: Requirement }) {
  return requirement === 'required' ? (
    <Badge variant="secondary">{BADGE.required}</Badge>
  ) : (
    <Badge variant="muted">{BADGE.optional}</Badge>
  );
}

interface FormFieldProps {
  label: string;
  requirement: Requirement;
  /** 単独の入力欄の id（label の htmlFor）。group のときは使わない */
  htmlFor?: string;
  /** 姓・名やラジオのように複数の入力欄をまとめる */
  group?: boolean;
  helper?: string;
  helperId?: string;
  error?: string | null;
  errorId?: string;
  /** 入力欄の右下の補足（文字数など） */
  aside?: ReactNode;
  children: ReactNode;
}

export default function FormField({
  label,
  requirement,
  htmlFor,
  group = false,
  helper,
  helperId,
  error,
  errorId,
  aside,
  children,
}: FormFieldProps) {
  const heading = (
    <span className="flex items-center gap-2 text-sm leading-5 font-medium text-foreground">
      {label}
      <RequirementBadge requirement={requirement} />
    </span>
  );
  const body = (
    <>
      {children}
      {(helper || aside) && (
        <div className="flex items-start justify-between gap-4 text-xs text-muted-foreground">
          {helper ? <p id={helperId}>{helper}</p> : <span />}
          {aside}
        </div>
      )}
      {error && (
        <p id={errorId} className="phrase text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );

  if (group) {
    return (
      <fieldset className="grid gap-2" aria-describedby={error ? errorId : undefined}>
        <legend className="mb-2">{heading}</legend>
        {body}
      </fieldset>
    );
  }
  return (
    <div className="grid gap-2">
      <label htmlFor={htmlFor} className="w-fit">
        {heading}
      </label>
      {body}
    </div>
  );
}
