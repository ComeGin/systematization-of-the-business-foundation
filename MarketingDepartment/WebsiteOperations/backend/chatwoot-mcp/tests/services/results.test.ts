import { describe, expect, it, vi } from "vitest";

import { CHARACTER_LIMIT, LONG_TEXT_LIMIT } from "../../src/constants.js";
import { ChatwootApiError } from "../../src/services/chatwoot-client.js";
import {
  compact,
  errorResult,
  errorText,
  fitToLimit,
  formattedResult,
  inline,
  jsonResult,
  pagedOutput,
  renderFields,
  sanitize,
  truncate,
  type PagedOutput,
} from "../../src/services/results.js";
import { textOf } from "../helpers/server.js";

describe("sanitize", () => {
  describe("秘匿情報の伏せ字", () => {
    it.each(["secret", "webhook_secret", "password", "access_token", "hmac_token", "api_key", "apikey", "API_KEY", "Secret", "AccessToken"])(
      "キー %s の値を [redacted] にする",
      (key) => {
        expect(sanitize({ [key]: "value" })).toEqual({ [key]: "[redacted]" });
      },
    );

    it("数値やオブジェクトの値も丸ごと伏せる", () => {
      expect(sanitize({ token: 12345, secret: { nested: "x" } })).toEqual({ token: "[redacted]", secret: "[redacted]" });
    });

    it("null・空文字・真偽値は「設定の有無」の情報なので伏せない", () => {
      expect(sanitize({ secret: null, access_token: "", hmac_enabled_token: true })).toEqual({ secret: null, access_token: "", hmac_enabled_token: true });
    });

    it("公開前提のキー（website_token・hmac_verified・hmac_mandatory）は例外として残す", () => {
      expect(sanitize({ website_token: "widget-abc", hmac_verified: "yes", hmac_mandatory: "no" })).toEqual({
        website_token: "widget-abc",
        hmac_verified: "yes",
        hmac_mandatory: "no",
      });
    });

    it("ネストしたオブジェクトと配列の中まで再帰的に伏せる", () => {
      const input = { inbox: { channel: { hmac_token: "h" } }, bots: [{ name: "faq", access_token: "t" }] };
      expect(sanitize(input)).toEqual({ inbox: { channel: { hmac_token: "[redacted]" } }, bots: [{ name: "faq", access_token: "[redacted]" }] });
    });

    it("秘匿でないキーの値はそのまま残す", () => {
      expect(sanitize({ id: 1, name: "inbox", enabled: false, tags: ["a"] })).toEqual({ id: 1, name: "inbox", enabled: false, tags: ["a"] });
    });

    it("元のオブジェクトは書き換えない", () => {
      const input = { secret: "s", nested: { password: "p" } };
      sanitize(input);
      expect(input).toEqual({ secret: "s", nested: { password: "p" } });
    });
  });

  describe("長い文字列の省略", () => {
    it(`${LONG_TEXT_LIMIT} 文字ちょうどは省略しない`, () => {
      const text = "あ".repeat(LONG_TEXT_LIMIT);
      expect(sanitize(text)).toBe(text);
    });

    it(`${LONG_TEXT_LIMIT + 1} 文字は先頭 200 文字と、元の長さ・include_long_text の案内に置き換える`, () => {
      const text = "x".repeat(LONG_TEXT_LIMIT + 1);
      const result = sanitize(text) as string;
      expect(result.startsWith("x".repeat(200) + "…")).toBe(true);
      expect(result).not.toContain("x".repeat(201));
      expect(result).toContain(`[omitted ${LONG_TEXT_LIMIT + 1} chars; call again with include_long_text=true for the full text]`);
    });

    it("includeLongText=true なら省略しない", () => {
      const text = "x".repeat(LONG_TEXT_LIMIT * 3);
      expect(sanitize({ body: text }, { includeLongText: true })).toEqual({ body: text });
    });

    it("maxText で上限を変えられる", () => {
      expect(sanitize("x".repeat(301), { maxText: 300 })).toContain("[omitted 301 chars");
      expect(sanitize("x".repeat(300), { maxText: 300 })).toBe("x".repeat(300));
    });

    it("includeLongText=true でも秘匿情報は伏せる", () => {
      expect(sanitize({ secret: "x".repeat(2000) }, { includeLongText: true })).toEqual({ secret: "[redacted]" });
    });

    it("文字列以外のプリミティブはそのまま返す", () => {
      expect(sanitize(5)).toBe(5);
      expect(sanitize(null)).toBeNull();
      expect(sanitize(undefined)).toBeUndefined();
    });
  });
});

describe("truncate", () => {
  it(`${CHARACTER_LIMIT} 文字以下はそのまま返す`, () => {
    const text = "x".repeat(CHARACTER_LIMIT);
    expect(truncate(text, "hint")).toBe(text);
  });

  it("上限を超えたら切り詰めて、上限と案内を付ける", () => {
    const result = truncate("x".repeat(CHARACTER_LIMIT + 10), "Narrow it.");
    expect(result.startsWith("x".repeat(CHARACTER_LIMIT) + "\n")).toBe(true);
    expect(result).toContain(`[truncated at ${CHARACTER_LIMIT} chars. Narrow it.]`);
  });
});

describe("errorResult / errorText", () => {
  it("errorText は isError=true のテキスト結果を返す", () => {
    expect(errorText("Error: x")).toEqual({ content: [{ type: "text", text: "Error: x" }], isError: true });
  });

  it("errorResult は describeError の文面と 404 の案内を使う", () => {
    const result = errorResult(new ChatwootApiError(404, "gone"), "Try list.");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Error: Not found (gone). Try list.");
  });
});

describe("jsonResult", () => {
  it("sanitize を通した JSON を返し、structuredContent は付けない", () => {
    const result = jsonResult({ webhook: { url: "https://x", secret: "s" } }, "");
    expect(JSON.parse(textOf(result))).toEqual({ webhook: { url: "https://x", secret: "[redacted]" } });
    expect(result.structuredContent).toBeUndefined();
  });

  it("includeLongText を sanitize に渡す", () => {
    const long = "y".repeat(LONG_TEXT_LIMIT + 1);
    expect(JSON.parse(textOf(jsonResult({ body: long }, "")))).not.toEqual({ body: long });
    expect(JSON.parse(textOf(jsonResult({ body: long }, "", { includeLongText: true })))).toEqual({ body: long });
  });

  it("上限を超えたら切り詰めて案内を付ける", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, text: "z".repeat(500) }));
    const text = textOf(jsonResult({ items }, "Use filters."));
    expect(text).toContain(`[truncated at ${CHARACTER_LIMIT} chars. Use filters.]`);
  });
});

describe("formattedResult", () => {
  const structured = { id: 1, name: "x" };

  it("json のときは本文も structuredContent も同じ JSON で、Markdown は組み立てない", () => {
    const render = vi.fn(() => "# md");
    const result = formattedResult(structured, "json", render, "");
    expect(JSON.parse(textOf(result))).toEqual(structured);
    expect(result.structuredContent).toEqual(structured);
    expect(render).not.toHaveBeenCalled();
  });

  it("markdown のときも structuredContent には JSON を入れる", () => {
    const result = formattedResult(structured, "markdown", () => "# md", "");
    expect(textOf(result)).toBe("# md");
    expect(result.structuredContent).toEqual(structured);
  });

  it("本文だけを切り詰め、structuredContent は切り詰めない", () => {
    const big = { body: "q".repeat(CHARACTER_LIMIT * 2) };
    const result = formattedResult(big, "json", () => "", "Use json.");
    expect(textOf(result)).toContain("[truncated at");
    expect(result.structuredContent).toEqual(big);
  });
});

describe("pagedOutput", () => {
  it("続きがあるときだけ next_page を付ける", () => {
    expect(pagedOutput(2, ["a"], true, 30)).toEqual({ page: 2, count: 1, total: 30, has_more: true, next_page: 3, items: ["a"] });
    expect(pagedOutput(2, ["a"], false)).toEqual({ page: 2, count: 1, has_more: false, items: ["a"] });
  });
});

describe("fitToLimit", () => {
  function output(count: number, itemSize: number): PagedOutput<string> {
    return pagedOutput(1, Array.from({ length: count }, () => "x".repeat(itemSize)), true, 100);
  }
  const render = (o: PagedOutput<string>) => o.items.join("");

  it("上限内ならそのまま返し、truncation_message を付けない", () => {
    const original = output(3, 100);
    const [result, text] = fitToLimit(original, render, "hint");
    expect(result).toBe(original);
    expect(result.truncation_message).toBeUndefined();
    expect(text).toBe(render(original));
  });

  it("上限に収まるまで件数を半分（切り上げ）ずつ減らす", () => {
    const counts: number[] = [];
    const [result, text] = fitToLimit(
      output(7, 10_000),
      (o) => {
        counts.push(o.items.length);
        return render(o);
      },
      "hint",
    );
    expect(counts).toEqual([7, 4, 2]);
    expect(result.count).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
  });

  it("truncation_message で、減らした件数と「次のページでは取れない」趣旨の案内を伝える", () => {
    const [result] = fitToLimit(output(10, 4_000), render, "Narrow the filters to see the rest.");
    expect(result.count).toBe(5);
    expect(result.truncation_message).toBe(
      "Response truncated to the first 5 items of this page to fit the size limit. Narrow the filters to see the rest.",
    );
  });

  it("ページ情報（page・total・has_more・next_page）は変えない", () => {
    const [result] = fitToLimit(output(10, 4_000), render, "");
    expect(result).toMatchObject({ page: 1, total: 100, has_more: true, next_page: 2 });
  });

  it("1 件でも上限を超える場合は 1 件で止める", () => {
    const [result, text] = fitToLimit(output(4, CHARACTER_LIMIT + 1), render, "");
    expect(result.count).toBe(1);
    expect(text.length).toBe(CHARACTER_LIMIT + 1);
  });

  it("元の出力オブジェクトは書き換えない", () => {
    const original = output(10, 4_000);
    fitToLimit(original, render, "");
    expect(original.items).toHaveLength(10);
    expect(original.truncation_message).toBeUndefined();
  });
});

describe("inline", () => {
  it("空値は - にする", () => {
    for (const value of [null, undefined, ""]) expect(inline(value)).toBe("-");
  });

  it("オブジェクトはコード表記の JSON にする", () => {
    expect(inline({ a: 1 })).toBe('`{"a":1}`');
  });

  it("改行を空白 1 つにまとめる", () => {
    expect(inline("line1  \n  line2\nline3")).toBe("line1 line2 line3");
  });
});

describe("compact", () => {
  it("null・undefined・空文字・空配列・空オブジェクトを除き、0 と false は残す", () => {
    expect(compact({ a: null, b: undefined, c: "", d: [], e: {}, f: 0, g: false, h: [1], i: { x: 1 } })).toEqual({ f: 0, g: false, h: [1], i: { x: 1 } });
  });
});

describe("renderFields", () => {
  it("スカラーは 1 行、プリミティブの配列はカンマ区切り、オブジェクトは JSON ブロックにする", () => {
    expect(renderFields({ name: "x", tags: ["a", "b"], config: { k: 1 }, empty: null })).toEqual([
      "- **name**: x",
      "- **tags**: a, b",
      "- **config**:",
      "```json",
      JSON.stringify({ k: 1 }, null, 2),
      "```",
    ]);
  });

  it("空の配列・空のオブジェクトは出さない", () => {
    expect(renderFields({ tags: [], config: {} })).toEqual([]);
  });
});
