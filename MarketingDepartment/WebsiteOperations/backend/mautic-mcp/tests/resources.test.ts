import { describe, expect, it } from "vitest";

import { CREATE_EXAMPLES, getResource, RESOURCE_NAMES, RESOURCES, WRITABLE_RESOURCE_NAMES, WRITABLE_RESOURCES } from "../src/resources.js";

describe("RESOURCES", () => {
  it("RESOURCE_NAMES は RESOURCES のキーと一致する", () => {
    expect([...RESOURCE_NAMES].sort()).toEqual(Object.keys(RESOURCES).sort());
  });

  it("参照用の resource に contacts は含めない（専用ツールがあるため）", () => {
    expect(RESOURCE_NAMES).not.toContain("contacts");
  });

  it("path は / で始まり、末尾にスラッシュを付けない", () => {
    for (const [name, resource] of Object.entries(RESOURCES)) {
      expect(resource.path, name).toMatch(/^\/[a-z/]+[a-z]$/);
    }
  });

  it("mautic_get_record で扱わない resource には必ず誘導先の案内を付ける", () => {
    const ungettable = Object.entries(RESOURCES).filter(([, resource]) => "gettable" in resource && resource.gettable === false);
    expect(ungettable.map(([name]) => name)).toEqual(["reports"]);
    for (const [, resource] of ungettable) expect("getHint" in resource && resource.getHint).toBeTruthy();
  });

  it("getResource は定義をそのまま返す", () => {
    expect(getResource("segments")).toBe(RESOURCES.segments);
  });
});

describe("WRITABLE_RESOURCES", () => {
  it("参照用の resource に contacts を加えたもの", () => {
    expect([...WRITABLE_RESOURCE_NAMES].sort()).toEqual(["contacts", ...RESOURCE_NAMES].sort());
    expect(Object.keys(WRITABLE_RESOURCES).sort()).toEqual([...WRITABLE_RESOURCE_NAMES].sort());
  });

  it("contacts は /contacts と contact を使う", () => {
    expect(WRITABLE_RESOURCES.contacts).toEqual({ path: "/contacts", one: "contact" });
  });

  it("各 resource の path と one は参照用の定義と同じ", () => {
    for (const name of RESOURCE_NAMES) {
      expect(WRITABLE_RESOURCES[name], name).toEqual({ path: RESOURCES[name].path, one: RESOURCES[name].one });
    }
  });
});

describe("CREATE_EXAMPLES", () => {
  it("書き込み可能な resource の例だけを持つ", () => {
    for (const name of Object.keys(CREATE_EXAMPLES)) expect(WRITABLE_RESOURCE_NAMES).toContain(name);
  });

  it("例の先頭の data 部分は JSON として読める（後ろの補足は 2 つの空白で区切る）", () => {
    for (const [name, example] of Object.entries(CREATE_EXAMPLES)) {
      const jsonPart = example!.split("  (")[0]!;
      expect(() => JSON.parse(jsonPart), name).not.toThrow();
      expect(Object.keys(JSON.parse(jsonPart) as object).length, name).toBeGreaterThan(0);
    }
  });
});
