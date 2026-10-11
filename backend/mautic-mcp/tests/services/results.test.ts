import { describe, expect, it } from "vitest";

import { CHARACTER_LIMIT, LONG_TEXT_LIMIT } from "../../src/constants.js";
import { MauticApiError } from "../../src/services/mautic-client.js";
import {
  errorResult,
  errorText,
  fitToLimit,
  inline,
  jsonResult,
  pagedOutput,
  sanitize,
  type PagedOutput,
} from "../../src/services/results.js";

// 上流を持たない純粋関数のため、サーバ側の異常は errorResult（上流の例外を文面にする）だけで確かめる

describe("sanitize: 秘匿情報の伏せ字", () => {
  describe("正常系", () => {
    it.each(["secret", "webhookSecret", "password", "plainPassword", "token", "accessToken", "api_key", "apiKey", "API_KEY"])(
      "キー %s の値を [redacted] にする",
      (key) => {
        expect(sanitize({ [key]: "value" })).toEqual({ [key]: "[redacted]" });
      },
    );

    it("数値やオブジェクトの値も伏せる", () => {
      expect(sanitize({ token: 12345, secret: { nested: "x" } })).toEqual({ token: "[redacted]", secret: "[redacted]" });
    });

    it("空入力: 値が null・空文字なら伏せずにそのまま残す（未設定と分かるように）", () => {
      expect(sanitize({ secret: null, password: "" })).toEqual({ secret: null, password: "" });
    });

    it("空入力: 空のオブジェクト・空の配列はそのまま返す", () => {
      expect(sanitize({})).toEqual({});
      expect(sanitize([])).toEqual([]);
    });

    it("ネストしたオブジェクト・配列の中のキーも伏せる", () => {
      const input = { hooks: [{ id: 1, secret: "s1", events: [{ apiKey: "k" }] }], meta: { inner: { password: "p" } } };
      expect(sanitize(input)).toEqual({
        hooks: [{ id: 1, secret: "[redacted]", events: [{ apiKey: "[redacted]" }] }],
        meta: { inner: { password: "[redacted]" } },
      });
    });

    it("秘匿でないキーの値は変えない", () => {
      const input = { id: 1, name: "Newsletter", isPublished: true, score: null, tags: ["a"] };
      expect(sanitize(input)).toEqual(input);
    });

    it("includeLongText=true でも秘匿情報は伏せる", () => {
      expect(sanitize({ secret: "x".repeat(5000) }, { includeLongText: true })).toEqual({ secret: "[redacted]" });
    });

    it("元のオブジェクトを書き換えない", () => {
      const input = { secret: "s", body: "x".repeat(LONG_TEXT_LIMIT + 1) };
      sanitize(input);
      expect(input.secret).toBe("s");
      expect(input.body).toHaveLength(LONG_TEXT_LIMIT + 1);
    });
  });
});

describe("sanitize: 長い文字列の省略", () => {
  describe("正常系", () => {
    it("LONG_TEXT_LIMIT ちょうどの文字列は省略しない", () => {
      const text = "a".repeat(LONG_TEXT_LIMIT);
      expect(sanitize(text)).toBe(text);
    });

    it("LONG_TEXT_LIMIT を超える文字列は先頭 200 文字と案内に置き換える", () => {
      const text = "b".repeat(LONG_TEXT_LIMIT + 1);
      expect(sanitize(text)).toBe(
        `${"b".repeat(200)}… [omitted ${LONG_TEXT_LIMIT + 1} chars; call again with include_long_text=true for the full text]`,
      );
    });

    it("includeLongText=true なら省略しない", () => {
      const text = "c".repeat(LONG_TEXT_LIMIT * 3);
      expect(sanitize({ html: text }, { includeLongText: true })).toEqual({ html: text });
    });

    it("maxText で上限を変えられる", () => {
      expect(sanitize("d".repeat(301), { maxText: 300 })).toMatch(/^d{200}… \[omitted 301 chars;/);
      expect(sanitize("d".repeat(300), { maxText: 300 })).toBe("d".repeat(300));
    });

    it("配列の要素の長い文字列も省略する", () => {
      const [first] = sanitize(["e".repeat(LONG_TEXT_LIMIT + 10)]) as string[];
      expect(first).toContain("[omitted");
    });

    it("空入力: 空文字はそのまま返す", () => {
      expect(sanitize("")).toBe("");
    });

    it("文字列以外のプリミティブはそのまま返す", () => {
      expect(sanitize(42)).toBe(42);
      expect(sanitize(true)).toBe(true);
      expect(sanitize(null)).toBeNull();
      expect(sanitize(undefined)).toBeUndefined();
    });
  });
});

describe("jsonResult", () => {
  describe("正常系", () => {
    it("sanitize した値を整形済み JSON のテキストで返す", () => {
      const result = jsonResult({ id: 1, secret: "s" }, "hint");
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ id: 1, secret: "[redacted]" }, null, 2) }]);
    });

    it("CHARACTER_LIMIT を超えたら切り詰めて hint を付ける", () => {
      const data = { rows: Array.from({ length: 200 }, (_, i) => ({ i, text: "x".repeat(500) })) };
      const result = jsonResult(data, "Use a smaller limit.");
      const text = (result.content[0] as { text: string }).text;
      expect(text.startsWith(JSON.stringify(sanitize(data), null, 2).slice(0, CHARACTER_LIMIT))).toBe(true);
      expect(text.endsWith(`\n… [truncated at ${CHARACTER_LIMIT} chars. Use a smaller limit.]`)).toBe(true);
    });

    it("CHARACTER_LIMIT 以内なら切り詰めない", () => {
      const text = (jsonResult({ a: 1 }, "hint").content[0] as { text: string }).text;
      expect(text).not.toContain("truncated");
    });

    it("空入力: 空のオブジェクト・空の配列は {}・[] のテキストを返す", () => {
      expect((jsonResult({}, "hint").content[0] as { text: string }).text).toBe("{}");
      expect((jsonResult([], "hint").content[0] as { text: string }).text).toBe("[]");
    });

    it("空入力: hint が空文字でも切り詰めの案内は付ける", () => {
      const text = (jsonResult({ rows: Array.from({ length: 100 }, () => "y".repeat(500)) }, "").content[0] as { text: string }).text;
      expect(text.endsWith(`\n… [truncated at ${CHARACTER_LIMIT} chars. ]`)).toBe(true);
    });
  });
});

describe("errorResult / errorText", () => {
  describe("正常系", () => {
    it("errorText は isError=true のテキスト結果を返す", () => {
      expect(errorText("Error: x")).toEqual({ content: [{ type: "text", text: "Error: x" }], isError: true });
    });

    it("errorResult は describeError の文面を使い、404 の案内を差し替えられる", () => {
      const result = errorResult(new MauticApiError(404, "missing"), "Look it up first.");
      expect(result).toEqual({ content: [{ type: "text", text: "Error: Not found (missing). Look it up first." }], isError: true });
    });

    it("空入力: errorResult に undefined を渡しても isError の結果を返す", () => {
      expect(errorResult(undefined)).toEqual({ content: [{ type: "text", text: "Error: Unexpected error: undefined" }], isError: true });
    });
  });

  describe("異常系", () => {
    it("サーバ: 5xx の上流の詳細（SQL など）はモデルに渡さない", () => {
      const result = errorResult(new MauticApiError(500, "SQLSTATE[42S22]: Column not found: 1054 Unknown column 'secret_col'"));
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).not.toContain("SQLSTATE");
    });

    it("サーバ: トークン取得の失敗は、再試行で直らないことを isError の結果で伝える", () => {
      const result = errorResult(new MauticApiError(400, "Failed to obtain Mautic access token: invalid_client"));
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("cannot be fixed by retrying");
    });
  });
});

describe("pagedOutput", () => {
  describe("正常系", () => {
    it("続きがあれば has_more=true と next_offset を付ける", () => {
      expect(pagedOutput(10, 4, [1, 2, 3])).toEqual({ total: 10, count: 3, offset: 4, has_more: true, next_offset: 7, items: [1, 2, 3] });
    });

    it("最後のページなら has_more=false で next_offset を付けない", () => {
      const output = pagedOutput(7, 4, [1, 2, 3]);
      expect(output.has_more).toBe(false);
      expect(output).not.toHaveProperty("next_offset");
    });

    it("空入力: 0 件でも形を保つ", () => {
      expect(pagedOutput(0, 0, [])).toEqual({ total: 0, count: 0, offset: 0, has_more: false, items: [] });
    });
  });
});

describe("fitToLimit", () => {
  const render = (o: PagedOutput<string>) => JSON.stringify(o);

  describe("正常系", () => {
    it("上限に収まるならそのまま返す", () => {
      const output = pagedOutput(3, 0, ["a", "b", "c"]);
      const [fitted, text] = fitToLimit(output, render);
      expect(fitted).toBe(output);
      expect(text).toBe(render(output));
    });

    it("空入力: 0 件ならそのまま返す", () => {
      const output = pagedOutput(0, 0, [] as string[]);
      const [fitted, text] = fitToLimit(output, render);
      expect(fitted).toBe(output);
      expect(text).toBe(render(output));
    });

    it("上限を超えたら件数を半分（切り上げ）ずつ減らし、続きの offset を案内する", () => {
      const item = "x".repeat(4000);
      const output = pagedOutput(100, 10, Array.from({ length: 10 }, () => item));
      const [fitted, text] = fitToLimit(output, render);

      // 10 → 5 件で 25,000 文字以内に収まる
      expect(fitted.items).toHaveLength(5);
      expect(fitted.count).toBe(5);
      expect(fitted.has_more).toBe(true);
      expect(fitted.next_offset).toBe(15);
      expect(fitted.truncation_message).toBe("Response truncated to 5 items to fit the size limit. Use a smaller limit or offset=15 to continue.");
      expect(text).toBe(render(fitted));
      expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    });

    it("最後のページでも切り詰めたら has_more=true にする", () => {
      const item = "y".repeat(10_000);
      const output = pagedOutput(4, 0, [item, item, item, item]);
      expect(output.has_more).toBe(false);
      const [fitted] = fitToLimit(output, render);
      expect(fitted.items).toHaveLength(2);
      expect(fitted.has_more).toBe(true);
      expect(fitted.next_offset).toBe(2);
    });

    it("1 件でも上限を超える場合は 1 件で止める", () => {
      const output = pagedOutput(3, 0, ["z".repeat(CHARACTER_LIMIT * 2), "a", "b"]);
      const [fitted, text] = fitToLimit(output, render);
      expect(fitted.items).toHaveLength(1);
      expect(text.length).toBeGreaterThan(CHARACTER_LIMIT);
    });

    it("items 以外の追加項目（resource など）を保つ", () => {
      const output = { ...pagedOutput(2, 0, ["q".repeat(20_000), "q".repeat(20_000)]), resource: "emails" };
      const [fitted] = fitToLimit(output, (o) => JSON.stringify(o));
      expect(fitted.resource).toBe("emails");
      expect(fitted.items).toHaveLength(1);
    });

    it("元の output を書き換えない", () => {
      const items = Array.from({ length: 4 }, () => "w".repeat(10_000));
      const output = pagedOutput(4, 0, items);
      fitToLimit(output, render);
      expect(output.items).toHaveLength(4);
      expect(output).not.toHaveProperty("truncation_message");
    });
  });
});

describe("inline", () => {
  describe("正常系", () => {
    it("空入力: null・undefined・空文字は - にする", () => {
      expect(inline(null)).toBe("-");
      expect(inline(undefined)).toBe("-");
      expect(inline("")).toBe("-");
    });

    it("オブジェクト・配列はバッククォートで囲んだ JSON にする", () => {
      expect(inline({ a: 1 })).toBe('`{"a":1}`');
      expect(inline([1, 2])).toBe("`[1,2]`");
    });

    it("その他は文字列化する（0 と false は - にしない）", () => {
      expect(inline(0)).toBe("0");
      expect(inline(false)).toBe("false");
      expect(inline("text")).toBe("text");
    });
  });
});
