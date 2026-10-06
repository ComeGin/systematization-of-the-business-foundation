import { describe, expect, it } from "vitest";

import { CREATABLE, DELETABLE, extractList, GETTABLE, getResource, LISTABLE, RESOURCES, unwrapRecord, UPDATABLE } from "../src/resources.js";

describe("リソース定義の整合性", () => {
  it("一覧から探して取得する（from_list）リソースは、一覧の形を持つ", () => {
    for (const name of GETTABLE) {
      const resource = getResource(name);
      if (resource.get === "from_list") expect(resource.list, name).toBeDefined();
    }
  });

  it("親リソース配下にだけ作るもの（portal_categories・portal_articles）は作成専用", () => {
    for (const name of ["portal_categories", "portal_articles"] as const) {
      expect(CREATABLE).toContain(name);
      expect(LISTABLE).not.toContain(name);
      expect(UPDATABLE).not.toContain(name);
      expect(DELETABLE).not.toContain(name);
      expect(getResource(name).parent?.path("my help")).toBe(`/portals/my%20help/${name === "portal_categories" ? "categories" : "articles"}`);
    }
  });

  it("integration_apps は参照専用、integration_hooks は書き込み専用", () => {
    expect(LISTABLE).toContain("integration_apps");
    expect([...CREATABLE, ...UPDATABLE, ...DELETABLE]).not.toContain("integration_apps");
    expect(LISTABLE).not.toContain("integration_hooks");
    expect(GETTABLE).not.toContain("integration_hooks");
  });

  it("受信箱とポータルは削除できない（削除ツールを公開しない）", () => {
    expect(DELETABLE).not.toContain("inboxes");
    expect(DELETABLE).not.toContain("portals");
  });

  it("ポータルは slug で指定する", () => {
    expect(RESOURCES.portals.idLabel).toBe("Portal slug");
  });
});

describe("extractList", () => {
  it("array は応答そのもの、payload は payload、payload.webhooks は payload.webhooks を取り出す", () => {
    expect(extractList("array", [{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(extractList("payload", { payload: [{ id: 2 }] })).toEqual([{ id: 2 }]);
    expect(extractList("payload.webhooks", { payload: { webhooks: [{ id: 3 }] } })).toEqual([{ id: 3 }]);
  });

  it("形が合わない・null のときは空配列にする", () => {
    expect(extractList("array", { payload: [] })).toEqual([]);
    expect(extractList("payload", null)).toEqual([]);
    expect(extractList("payload.webhooks", { payload: [] })).toEqual([]);
  });
});

describe("unwrapRecord", () => {
  it("{ payload: {...} } だけの応答は中身を取り出す", () => {
    expect(unwrapRecord({ payload: { id: 1, name: "x" } })).toEqual({ id: 1, name: "x" });
  });

  it("payload 以外のキーもあるときは包みを外さない", () => {
    expect(unwrapRecord({ payload: { id: 1 }, meta: {} })).toEqual({ payload: { id: 1 }, meta: {} });
  });

  it("payload が配列のときは外さない", () => {
    expect(unwrapRecord({ payload: [1] })).toEqual({ payload: [1] });
  });

  it("オブジェクトでない応答（null・配列）は { result } に包む", () => {
    expect(unwrapRecord(null)).toEqual({ result: null });
    expect(unwrapRecord([1, 2])).toEqual({ result: [1, 2] });
  });
});
