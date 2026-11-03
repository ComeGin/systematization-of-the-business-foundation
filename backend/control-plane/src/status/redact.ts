// 設定の状況: 保存・画面・メールに出す前に、秘密値を監視アプリの側でもう一度伏せる（spec の 5.1・6）。
// 子プロセス（設定スクリプト）の出力は setup/lib/core.mjs の mask() を通してあるが、それに頼り切らない。
// 規則は mask() と同じ: 長い値から順に、値の出現をすべて「[伏せ字]」に置き換える
// （短い値が長い値の一部だと、短いほうを先に伏せたときに長いほうの残りの文字が出てしまうため）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REDACTED = "[伏せ字]";

/** prod.conf の値として伏せる最短の長さ（短い値〈yes・true・数字〉を伏せると、根拠の文が読めなくなる） */
const MIN_CONF_LENGTH = 8;
/** 状態ファイルの secrets・資格情報ファイルの値として伏せる最短の長さ（core.mjs の registerSecret と同じ） */
const MIN_SECRET_LENGTH = 6;

/**
 * prod.conf のうち、場所を表す値（URL・ホスト・ドメイン・ディレクトリ・イメージの名前・リージョン）のキー。
 * これらは秘密値ではなく、伏せると根拠（例「https://… に届かない」）が読めなくなるので伏せない。
 * ここに無いキーは、8 文字以上なら秘密値でなくても伏せる（メールアドレス・ID なども画面とメールに出さない）。
 */
const LOCATION_KEY = /(_URL|_BASE|_HOST|_DOMAIN|_REGION|_CHECKOUT|_DIR|_IMAGE)$/;

/** .env・prod.conf の形（KEY=VALUE。# の行は読まない。値の両端の引用符を外す）。core.mjs の parseKeyValue と同じ。 */
function parseKeyValue(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 値と、カンマ区切りの各要素（例 CONTROL_ADMIN_EMAILS）を、長さの条件を満たすものだけ足す。 */
function addValue(out: Set<string>, value: string, min: number): void {
  const trimmed = value.trim();
  if (trimmed.length >= min) out.add(trimmed);
  if (trimmed.includes(",")) {
    for (const part of trimmed.split(",")) {
      const p = part.trim();
      if (p.length >= min) out.add(p);
    }
  }
}

/**
 * AWS の資格情報ファイル（INI）なら aws_* のキー（aws_access_key_id・aws_secret_access_key・aws_session_token）の値だけを返す
 * （region などは秘密値ではなく、伏せると根拠の文の「ap-northeast-1」まで伏せてしまうため）。
 * INI の形（[section] か key = value の行がある）でなければ null（中身そのものがトークン）。
 */
function credentialValues(text: string): string[] | null {
  const values: string[] = [];
  let ini = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      ini = true;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    ini = true;
    if (/^aws_/i.test(line.slice(0, eq).trim())) values.push(line.slice(eq + 1).trim());
  }
  return ini ? values : null;
}

/**
 * 伏せる値の一覧を作る。呼ぶたびにファイルを読み直す（値をプロセスに持ち続けない。設定スクリプトが書き換えても追いつく）。
 *   - ~/.config/comegin/setup/prod.conf の 8 文字以上の値（場所を表すキー〈LOCATION_KEY〉を除く）
 *   - ~/.config/comegin/setup/prod.state.json の secrets に載ったキーの値
 *   - credentialFiles（状況の確認の AWS の資格情報・GitHub のトークン）の中身の値
 * ファイルが無い・読めないものは飛ばす（伏せる値が無いだけで、確認は止めない）。
 */
export function collectSecrets(home: string, credentialFiles: readonly string[] = []): string[] {
  const out = new Set<string>();
  const setupDir = join(home, ".config/comegin/setup");

  const conf = readOrNull(join(setupDir, "prod.conf"));
  if (conf !== null) {
    for (const [key, value] of Object.entries(parseKeyValue(conf))) {
      if (LOCATION_KEY.test(key)) continue;
      addValue(out, value, MIN_CONF_LENGTH);
    }
  }

  const stateText = readOrNull(join(setupDir, "prod.state.json"));
  if (stateText !== null) {
    try {
      const state = JSON.parse(stateText) as { values?: Record<string, unknown>; secrets?: unknown };
      const secrets = Array.isArray(state.secrets) ? state.secrets : [];
      for (const key of secrets) {
        if (typeof key !== "string") continue;
        const value = state.values?.[key];
        if (typeof value === "string") addValue(out, value, MIN_SECRET_LENGTH);
      }
    } catch {
      // 壊れた状態ファイルは読まない（設定スクリプト側でも読めないので、子プロセスが止まる）
    }
  }

  for (const file of credentialFiles) {
    const text = readOrNull(file);
    if (text === null) continue;
    const values = credentialValues(text);
    // GitHub のトークンのファイルは中身そのもの（= を含まない 1 行）
    if (values === null) addValue(out, text, MIN_SECRET_LENGTH);
    else for (const value of values) addValue(out, value, MIN_SECRET_LENGTH);
  }

  return [...out];
}

/** text の中の secrets の値をすべて伏せる。長い値から伏せる（core.mjs の mask と同じ）。 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}
