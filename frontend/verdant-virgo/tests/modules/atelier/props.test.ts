import { describe, expect, it } from "vitest";
import {
  PROPS,
  assertPropsOneToOne,
  pageKeyForPath,
  type PropDef,
} from "@/modules/atelier/client";

// 置き物と Tips と移り先（spec §5.2）。置き物・Tips・移り先のページは 1 対 1（アンチゴール 1「論理的に破綻している」）。

const def = (over: Partial<PropDef> & Pick<PropDef, "id">): PropDef => ({
  node: `prop_${over.id}`,
  anchor: `anchor_${over.id}`,
  href: null,
  still: null,
  ...over,
});

describe("PROPS", () => {
  describe("正常系", () => {
    it("PROPS のキーと各 id が一致し、node・anchor は prop_<id>・anchor_<id>", () => {
      for (const [key, p] of Object.entries(PROPS)) {
        expect(p.id).toBe(key);
        expect(p.node).toBe(`prop_${key}`);
        expect(p.anchor).toBe(`anchor_${key}`);
      }
      expect(Object.keys(PROPS)).toHaveLength(10);
    });

    it("移り先は spec §5.2 のとおり", () => {
      expect(PROPS.nameplate.href).toBe("/about/");
      expect(PROPS.envSetup.href).toBe("/services/environment-setup/");
      expect(PROPS.development.href).toBe("/services/development/");
      expect(PROPS.consulting.href).toBe("/services/consulting/");
      expect(PROPS.partnership.href).toBe("/services/partnership/");
      expect(PROPS.pricing.href).toBe("/pricing/");
      expect(PROPS.blog.href).toBe("/blog/");
      expect(PROPS.contact.href).toBe("/contact/");
      expect(PROPS.avatar.href).toBeNull();
      expect(PROPS.wall.href).toBeNull();
    });

    it("href のある置き物の still は pageKeyForPath(href) と同じ", () => {
      for (const p of Object.values(PROPS)) {
        if (p.href) expect(p.still).toBe(pageKeyForPath(p.href));
        else expect(p.still).toBeNull();
      }
    });

    it("PROPS は assertPropsOneToOne を通る", () => {
      expect(() => assertPropsOneToOne(PROPS)).not.toThrow();
    });
  });

  describe("異常系", () => {
    it("入力: 2 つの置き物が同じ href を持つと拒む", () => {
      expect(() =>
        assertPropsOneToOne({
          pricing: def({ id: "pricing", href: "/pricing/", still: "pricing" }),
          blog: def({ id: "blog", href: "/pricing/", still: "pricing" }),
        }),
      ).toThrow(/blog/);
    });

    it("入力: still が href のページと違うと拒む", () => {
      expect(() =>
        assertPropsOneToOne({
          pricing: def({ id: "pricing", href: "/pricing/", still: "blog" }),
        }),
      ).toThrow(/pricing/);
    });

    it("入力: href が null なのに still があると拒む", () => {
      expect(() =>
        assertPropsOneToOne({
          wall: def({ id: "wall", href: null, still: "accessibility" }),
        }),
      ).toThrow(/wall/);
    });

    it("空入力: 空の表は拒む", () => {
      expect(() => assertPropsOneToOne({})).toThrow();
    });
  });
});
