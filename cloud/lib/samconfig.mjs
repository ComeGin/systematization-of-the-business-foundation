// デプロイ設定ファイル（cloud/ の追跡しない設定ファイル。雛形は cloud/ の .example）の parameter_overrides の読み取り。
// 必要なのは `[<env>.deploy.parameters]` の表の `parameter_overrides = [ "Key=Value", ... ]` だけなので、TOML の依存は足さず、この形だけを読む。
// 値は秘密を含みうる（ARN・メール・Client ID）。例外の文にも値を入れない。

const SHA = /^[0-9a-f]{40}$/;

/** 行頭の `[...]` の表の見出し。見出しなら表の名前（空白を除く）、でなければ null。`[[配列の表]]` は別の表として扱う */
function tableHeader(line) {
  const m = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
  return m ? m[1].replace(/\s+/g, "") : null;
}

/**
 * text の index から始まる配列（`[` の直後）を読み、文字列の要素と、`]` の次の位置を返す。
 * 基本文字列（"..."。JSON と同じエスケープ）とリテラル文字列（'...'）と、文字列の外の # のコメントを扱う。閉じていなければ null
 */
function readStringArray(text, index) {
  const items = [];
  let i = index;
  while (i < text.length) {
    const c = text[i];
    if (c === "]") return { items, end: i + 1 };
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return null;
      try {
        items.push(JSON.parse(text.slice(i, j + 1)));
      } catch {
        throw new Error("parameter_overrides の要素を文字列として読めない");
      }
      i = j + 1;
    } else if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) return null;
      items.push(text.slice(i + 1, j));
      i = j + 1;
    } else {
      i++; // 空白・改行・カンマ
    }
  }
  return null;
}

/**
 * `[<env>.deploy.parameters]` の parameter_overrides の各要素（"Key=Value"）。表が無い・キーが無いときは []。
 * env は "default" か "global"（samconfig の環境名）。書き方が配列でない・閉じていないときは、値を含めずに例外
 */
export function parameterOverrides(tomlText, env) {
  const text = tomlText.replace(/\r\n?/g, "\n");
  const wanted = `${env}.deploy.parameters`;
  const lines = text.split("\n");
  let offset = 0;
  let inTable = false;
  for (const line of lines) {
    const header = tableHeader(line);
    if (header !== null) {
      inTable = header === wanted;
    } else if (inTable) {
      const m = line.match(/^\s*parameter_overrides\s*=\s*(.*)$/);
      if (m) {
        const valueStart = offset + line.length - m[1].length;
        if (!m[1].startsWith("[")) throw new Error(`${wanted} の parameter_overrides が配列（[ "Key=Value", ... ]）の形でない`);
        const parsed = readStringArray(text, valueStart + 1);
        if (!parsed) throw new Error(`${wanted} の parameter_overrides の配列が閉じていない`);
        return parsed.items;
      }
    }
    offset += line.length + 1;
  }
  return [];
}

/** overrides（"Key=Value" の配列）から name の値。無ければ undefined。最初の = で分ける（値に = があってもよい） */
export function overrideValue(overrides, name) {
  for (const item of overrides) {
    const eq = item.indexOf("=");
    if (eq > 0 && item.slice(0, eq) === name) return item.slice(eq + 1);
  }
  return undefined;
}

/** 既存の DeployedCommit= を除いてから、末尾に DeployedCommit=<sha> を足した新しい配列（元の配列は変えない） */
export function withDeployedCommit(overrides, sha) {
  if (!SHA.test(sha)) throw new Error("DeployedCommit に渡すコミットが 40 桁の16進でない");
  return [...overrides.filter((item) => !item.startsWith("DeployedCommit=")), `DeployedCommit=${sha}`];
}
