import { describe, expect, it } from "vitest";

import { CREATABLE, DELETABLE, extractList, GETTABLE, getResource, LISTABLE, RESOURCES, unwrapRecord, UPDATABLE } from "../src/resources.js";

// リソース定義は定数表の検査なので正常系だけを置く。extractList / unwrapRecord は上流の応答を受け取る純粋関数で、
// 想定外の形の応答は「入力:」として扱う（自分では HTTP を呼ばない）

describe("リソース定義の整合性", () => {
  describe("正常系", () => {
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

    it("どの分類も 1 件以上あり、すべてのリソースにパス・説明・名前のキーがある", () => {
      for (const names of [LISTABLE, GETTABLE, CREATABLE, UPDATABLE, DELETABLE]) expect(names.length).toBeGreaterThan(0);
      for (const [name, resource] of Object.entries(RESOURCES)) {
        expect(resource.path, name).toMatch(/^\//);
        expect(resource.description, name).toBeTruthy();
        expect(resource.nameKey, name).toBeTruthy();
      }
    });
  });
});

describe("extractList", () => {
  describe("正常系", () => {
    it("array は応答そのもの、payload は payload、payload.webhooks は payload.webhooks を取り出す", () => {
      expect(extractList("array", [{ id: 1 }])).toEqual([{ id: 1 }]);
      expect(extractList("payload", { payload: [{ id: 2 }] })).toEqual([{ id: 2 }]);
      expect(extractList("payload.webhooks", { payload: { webhooks: [{ id: 3 }] } })).toEqual([{ id: 3 }]);
    });

    it("空入力: 0 件の応答（空配列・空の payload）は空配列を返す", () => {
      expect(extractList("array", [])).toEqual([]);
      expect(extractList("payload", { payload: [] })).toEqual([]);
      expect(extractList("payload.webhooks", { payload: { webhooks: [] } })).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 形が合わない応答は例外にせず空配列にする", () => {
      expect(extractList("array", { payload: [] })).toEqual([]);
      expect(extractList("payload.webhooks", { payload: [] })).toEqual([]);
      expect(extractList("payload", { payload: "not-a-list" })).toEqual([]);
    });

    it("空入力: null・undefined・空オブジェクトの応答は空配列にする", () => {
      for (const shape of ["array", "payload", "payload.webhooks"] as const) {
        expect(extractList(shape, null), shape).toEqual([]);
        expect(extractList(shape, undefined), shape).toEqual([]);
        expect(extractList(shape, {}), shape).toEqual([]);
      }
    });
  });
});

describe("unwrapRecord", () => {
  describe("正常系", () => {
    it("{ payload: {...} } だけの応答は中身を取り出す", () => {
      expect(unwrapRecord({ payload: { id: 1, name: "x" } })).toEqual({ id: 1, name: "x" });
    });

    it("payload 以外のキーもあるときは包みを外さない", () => {
      expect(unwrapRecord({ payload: { id: 1 }, meta: {} })).toEqual({ payload: { id: 1 }, meta: {} });
    });

    it("空入力: 空オブジェクトはそのまま返す", () => {
      expect(unwrapRecord({})).toEqual({});
    });
  });

  describe("異常系", () => {
    it("入力: payload が配列・null のときは外さない", () => {
      expect(unwrapRecord({ payload: [1] })).toEqual({ payload: [1] });
      expect(unwrapRecord({ payload: null })).toEqual({ payload: null });
    });

    it("入力: オブジェクトでない応答（配列・文字列）は { result } に包む", () => {
      expect(unwrapRecord([1, 2])).toEqual({ result: [1, 2] });
      expect(unwrapRecord("ok")).toEqual({ result: "ok" });
    });

    it("空入力: 本文なし（null）・undefined は { result } に包む", () => {
      expect(unwrapRecord(null)).toEqual({ result: null });
      expect(unwrapRecord(undefined)).toEqual({ result: undefined });
    });
  });
});
