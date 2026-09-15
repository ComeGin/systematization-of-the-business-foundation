/**
 * Mautic の一覧 API は結果を `{"<multi>": {"4": {...}, "1": {...}}}` のように ID をキーにしたオブジェクトで返す。
 * JavaScript のオブジェクトは整数キーを昇順に並べ替えるため、JSON.parse すると API 側の並び順が失われる。
 * ここでは JSON 文字列を走査し、最上位オブジェクトの `property` の値に含まれるキーを出現順で返す。
 *
 * @returns キーの配列。`property` がない・オブジェクトでない（配列など）場合は null
 */
export function objectKeyOrder(json: string, property: string): string[] | null {
  let depth = 0;
  let targetDepth = -1;
  let awaitingTarget = false;
  const keys: string[] = [];

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;

    if (ch === '"') {
      const end = endOfString(json, i);
      let next = end + 1;
      while (next < json.length && isWhitespace(json[next]!)) next++;

      if (json[next] === ":") {
        const key = JSON.parse(json.slice(i, end + 1)) as string;
        if (depth === targetDepth) keys.push(key);
        else if (targetDepth < 0 && depth === 1 && key === property) awaitingTarget = true;
        i = next;
      } else {
        i = end;
      }
      continue;
    }

    if (ch === "{" || ch === "[") {
      depth++;
      if (awaitingTarget) {
        if (ch === "[") return null;
        targetDepth = depth;
        awaitingTarget = false;
      }
    } else if (ch === "}" || ch === "]") {
      if (depth === targetDepth) return keys;
      depth--;
    } else if (awaitingTarget && !isWhitespace(ch)) {
      // null・数値など、オブジェクト以外の値
      return null;
    }
  }
  return null;
}

function endOfString(json: string, start: number): number {
  for (let i = start + 1; i < json.length; i++) {
    if (json[i] === "\\") i++;
    else if (json[i] === '"') return i;
  }
  throw new SyntaxError("Unterminated string in JSON");
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

/** 一覧 API のレスポンスから、API の並び順を保ったまま要素の配列を取り出す */
export function orderedValues<T>(raw: string, parsed: Record<string, unknown>, property: string): T[] {
  const value = parsed[property];
  if (Array.isArray(value)) return value as T[];
  if (value === null || typeof value !== "object") return [];

  const record = value as Record<string, T>;
  const order = objectKeyOrder(raw, property) ?? Object.keys(record);
  return order.map((key) => record[key]!).filter((item) => item !== undefined);
}
