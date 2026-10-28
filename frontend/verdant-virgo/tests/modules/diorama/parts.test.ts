import { describe, expect, it } from "vitest";
import { PARTS, type PartId } from "@/modules/diorama/client";

// 模型の部品の対応表（spec §5.1）。部品は実際の仕組みと 1 対 1 で対応する（アンチゴール 1「論理的に破綻している」）。
// PARTS は定数で、関数の入力が無いので「空入力: 」「入力: 」のケースは置かない。

const ids = Object.keys(PARTS) as PartId[];

describe("PARTS", () => {
  describe("正常系", () => {
    it("PARTS のキーと各 id が一致する", () => {
      for (const id of ids) expect(PARTS[id].id).toBe(id);
      expect(ids).toHaveLength(14);
    });

    it("押せる部品は、基盤の部品（土台を除く）と仕事の 3 つだけ", () => {
      const touchable = ids.filter((id) => PARTS[id].touchable).sort();
      expect(touchable).toEqual(
        [
          "agents",
          "approval",
          "bridge",
          "desk",
          "drafting",
          "gauge",
          "pipe",
          "roster",
          "shelf",
          "shipping",
          "site",
          "workshop",
        ].sort(),
      );
      expect(PARTS.base.touchable).toBe(false);
      expect(PARTS.priceTag.touchable).toBe(false);
    });

    it("仕事の部品は workshop・drafting・bridge の 3 つ", () => {
      expect(ids.filter((id) => PARTS[id].kind === "work").sort()).toEqual([
        "bridge",
        "drafting",
        "workshop",
      ]);
    });

    it("窓口のデータの持ち主は Chatwoot だけ、名簿は Mautic だけ", () => {
      expect(PARTS.desk.products).toEqual(["Chatwoot"]);
      expect(PARTS.roster.products).toEqual(["Mautic"]);
    });

    it("承認台は人の承認 4 つを持つ", () => {
      expect(PARTS.approval.products).toEqual([
        "GitHub の PR",
        "Strapi（公開の判断）",
        "配信の承認",
        "n8n（有効化）",
      ]);
    });

    it("node・anchor の名前は part_<id>・anchor_<id>", () => {
      for (const id of ids) {
        expect(PARTS[id].node).toBe(`part_${id}`);
        expect(PARTS[id].anchor).toBe(`anchor_${id}`);
      }
    });

    it("接地影の板は、土台と値札には無く、ほかの部品には shadow_<id> がある", () => {
      expect(PARTS.base.shadow).toBeNull();
      expect(PARTS.priceTag.shadow).toBeNull();
      for (const id of ids.filter((id) => id !== "base" && id !== "priceTag"))
        expect(PARTS[id].shadow).toBe(`shadow_${id}`);
    });
  });
});
