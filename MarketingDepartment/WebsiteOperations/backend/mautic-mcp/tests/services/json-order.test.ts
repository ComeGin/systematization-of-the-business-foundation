import { describe, expect, it } from "vitest";

import { objectKeyOrder, orderedValues } from "../../src/services/json-order.js";

describe("objectKeyOrder", () => {
  it("整数キーでも JSON 文字列に現れた順のまま返す", () => {
    expect(objectKeyOrder('{"total":3,"emails":{"4":{},"1":{},"10":{}}}', "emails")).toEqual(["4", "1", "10"]);
  });

  it("要素の中のネストしたキーは含めない", () => {
    const json = '{"emails":{"2":{"id":2,"category":{"id":7,"title":"x"}},"1":{"id":1,"lists":[{"9":1}]}}}';
    expect(objectKeyOrder(json, "emails")).toEqual(["2", "1"]);
  });

  it("最上位以外にある同名のキーは対象にしない", () => {
    const json = '{"meta":{"emails":{"99":{}}},"emails":{"3":{},"1":{}}}';
    expect(objectKeyOrder(json, "emails")).toEqual(["3", "1"]);
  });

  it("文字列の値として現れた同名の語はキーとして扱わない", () => {
    const json = '{"name":"emails","emails":{"5":{},"2":{}}}';
    expect(objectKeyOrder(json, "emails")).toEqual(["5", "2"]);
  });

  it("文字列中の括弧・エスケープされた引用符に惑わされない", () => {
    const json = '{"emails":{"8":{"subject":"a \\"quoted\\" {brace} [x]: y"},"3":{"html":"}}]]"}}}';
    expect(objectKeyOrder(json, "emails")).toEqual(["8", "3"]);
  });

  it("キーとコロンの間の空白・改行を許す", () => {
    const json = '{\n  "emails" :\n  {\n    "7" : {},\n    "6"\t: {}\n  }\n}';
    expect(objectKeyOrder(json, "emails")).toEqual(["7", "6"]);
  });

  it("エスケープを含むキーは JSON としてデコードして返す", () => {
    expect(objectKeyOrder('{"items":{"a\\u0062":1,"c\\"d":2}}', "items")).toEqual(["ab", 'c"d']);
  });

  it("空のオブジェクトなら空配列を返す", () => {
    expect(objectKeyOrder('{"emails":{}}', "emails")).toEqual([]);
  });

  it("値が配列なら null を返す", () => {
    expect(objectKeyOrder('{"emails":[{"id":1}]}', "emails")).toBeNull();
  });

  it("値が null・数値なら null を返す", () => {
    expect(objectKeyOrder('{"emails":null}', "emails")).toBeNull();
    expect(objectKeyOrder('{"emails":0}', "emails")).toBeNull();
  });

  it("property がなければ null を返す", () => {
    expect(objectKeyOrder('{"total":0}', "emails")).toBeNull();
  });

  it("閉じていない文字列は SyntaxError にする", () => {
    expect(() => objectKeyOrder('{"emails":{"1', "emails")).toThrow(SyntaxError);
  });

  it("値が文字列なら、後続のプロパティがオブジェクトでも null を返す", () => {
    expect(objectKeyOrder('{"emails":"none","other":{"a":1}}', "emails")).toBeNull();
    expect(objectKeyOrder('{"emails":"none"}', "emails")).toBeNull();
  });
});

describe("orderedValues", () => {
  it("オブジェクトの値を API の並び順で配列にする", () => {
    const raw = '{"lists":{"3":{"id":3},"1":{"id":1},"2":{"id":2}}}';
    expect(orderedValues<{ id: number }>(raw, JSON.parse(raw), "lists").map((item) => item.id)).toEqual([3, 1, 2]);
  });

  it("値が配列ならそのまま返す", () => {
    const parsed = { submissions: [{ id: 2 }, { id: 1 }] };
    expect(orderedValues(JSON.stringify(parsed), parsed, "submissions")).toBe(parsed.submissions);
  });

  it("値が null・プリミティブ・欠落なら空配列を返す", () => {
    expect(orderedValues('{"emails":null}', { emails: null }, "emails")).toEqual([]);
    expect(orderedValues('{"emails":"x"}', { emails: "x" }, "emails")).toEqual([]);
    expect(orderedValues("{}", {}, "emails")).toEqual([]);
  });

  it("生の JSON から順序が取れなければ Object.keys の順にする", () => {
    const parsed = { emails: { "2": { id: 2 }, "1": { id: 1 } } };
    expect(orderedValues<{ id: number }>("{}", parsed, "emails").map((item) => item.id)).toEqual([1, 2]);
  });
});
