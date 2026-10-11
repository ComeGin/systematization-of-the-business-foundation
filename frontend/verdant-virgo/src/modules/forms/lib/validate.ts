// 入力の検証（01-content-spec.md §5.1 の「バリデーションの文言」）。従業員数・IT の担当部署は検証しない。
import { CONSULT_TEXT, VALIDATION } from "./messages";

/** 文字数は書記素ではなくコードポイントで数える（サロゲートペアを 2 文字に数えない） */
export const charCount = (value: string): number => Array.from(value).length;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCompany(value: string): string | null {
  if (!value.trim()) return VALIDATION.companyRequired;
  if (charCount(value) > 100) return VALIDATION.companyTooLong;
  return null;
}

export function validateLastname(value: string): string | null {
  if (!value.trim()) return VALIDATION.lastnameRequired;
  if (charCount(value) > 50) return VALIDATION.nameTooLong;
  return null;
}

export function validateFirstname(value: string): string | null {
  if (!value.trim()) return VALIDATION.firstnameRequired;
  if (charCount(value) > 50) return VALIDATION.nameTooLong;
  return null;
}

export function validateEmail(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return VALIDATION.emailRequired;
  if (charCount(trimmed) > 254 || !EMAIL_PATTERN.test(trimmed))
    return VALIDATION.emailInvalid;
  return null;
}

export function validateMessage(value: string): string | null {
  if (!value.trim()) return VALIDATION.messageRequired;
  if (charCount(value) > 2000) return VALIDATION.messageTooLong;
  return null;
}

export function validatePrivacy(checked: boolean): string | null {
  return checked ? null : VALIDATION.privacyRequired;
}

/**
 * 任意の選択肢（従業員数・IT の担当部署）の値。選択肢の外の値（未選択の空文字・DOM を書き換えられた値）は null にして送らない。
 * エラーは出さない（§5.1）。
 */
export function pickEmployeeRange(value: string): string | null {
  return CONSULT_TEXT.employeeOptions.some((option) => option.value === value) ? value : null;
}

export function pickItDepartment(value: string): string | null {
  return CONSULT_TEXT.itDepartmentOptions.some((option) => option.value === value) ? value : null;
}
