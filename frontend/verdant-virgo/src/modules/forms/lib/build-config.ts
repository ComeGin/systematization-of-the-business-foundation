// ビルド時に .astro が読む設定（P-8: MAUTIC_FORM_ID_* は PUBLIC_ を付けずに読み、props で island に渡す）。
// 配信用のビルド（BUILD_TARGET=production）で未設定ならビルドを止める（CV が黙って失われるのを防ぐ）。
// 開発で未設定なら null を返し、フォームは送信を失敗として表示する。

function requireForProduction(name: string, value: string | undefined): void {
  if (value || import.meta.env.BUILD_TARGET !== 'production') return;
  throw new Error(`${name} が未設定です。配信用のビルド（BUILD_TARGET=production）では必須です。`);
}

export function readFormId(name: 'MAUTIC_FORM_ID_CONSULT'): number | null {
  // import.meta.env は動的なキーで読めない（Vite が静的に置き換えるため）。無料 DL のフォーム（MAUTIC_FORM_ID_SOURCE_DL）は 2026-10-20 に消した
  const raw = import.meta.env.MAUTIC_FORM_ID_CONSULT?.trim();
  requireForProduction(name, raw);
  if (!raw) return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new Error(`${name} は 1 以上の整数にしてください。`);
  return id;
}

export function readPolicyVersion(): string {
  const version = import.meta.env.CONSENT_POLICY_VERSION?.trim() ?? '';
  requireForProduction('CONSENT_POLICY_VERSION', version);
  return version;
}
