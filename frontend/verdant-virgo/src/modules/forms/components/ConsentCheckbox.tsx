// 「プライバシーポリシーに同意する」のチェックボックス（必須。01-content-spec.md §5.1 の 7・§5.2 の 2）。
// 「プライバシーポリシー」は /legal/privacy へのリンクで、新しいタブで開く（リンクの名前の末尾で告知する。§12 の S-2）。
import { useId, type Ref } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { NewTabNotice } from "@/modules/a11y/client";
import { NEW_TAB_NOTICE } from "@/modules/site-content/a11y";
import { PRIVACY_CONSENT } from "../lib/messages";
import { RequirementBadge } from "./FormField";

interface ConsentCheckboxProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onBlur?: () => void;
  error?: string | null;
  errorId: string;
  disabled?: boolean;
  checkboxRef?: Ref<HTMLElement>;
}

export default function ConsentCheckbox({
  id,
  checked,
  onCheckedChange,
  onBlur,
  error,
  errorId,
  disabled,
  checkboxRef,
}: ConsentCheckboxProps) {
  // 読み上げ用の名前。span の role=checkbox は label から名前を受け取れないので、
  // サーバーの HTML の時点から aria-labelledby で文字を指す（水和の前・JS の失敗でも名前が付く）。
  // リンクの文字と「に同意する」を別々に指し、リンクの中の新しいタブの告知はチェックボックスの名前に混ぜない
  const uid = useId();
  const linkTextId = `${uid}-link`;
  const restId = `${uid}-rest`;
  return (
    <div className="grid gap-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          id={id}
          aria-labelledby={`${linkTextId} ${restId}`}
          ref={checkboxRef}
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          onBlur={onBlur}
          disabled={disabled}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <span className="phrase">
          <a
            href={PRIVACY_CONSENT.href}
            target="_blank"
            rel="noopener"
            className="text-text-link underline underline-offset-4 hover:text-text-link-hover"
          >
            <span id={linkTextId}>{PRIVACY_CONSENT.linkText}</span>
            <NewTabNotice text={NEW_TAB_NOTICE} />
          </a>
          <span id={restId}>{PRIVACY_CONSENT.rest}</span>
        </span>
        <RequirementBadge requirement="required" />
      </label>
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
