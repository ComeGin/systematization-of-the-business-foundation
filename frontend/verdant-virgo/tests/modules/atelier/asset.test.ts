import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FRAME_SLOTS,
  PROPS,
  STILL_VIEWS,
  readGlbJson,
} from "@/modules/atelier/client";

// アトリエの glb（Blender で作った正本の書き出し）が、コードの約束どおりのノードを持つか（計画 Task 2 の Produces）。
// glb の JSON チャンクだけを読む（three は使わない）。予算は spec §10。

const ASSETS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/modules/atelier/assets",
);
const GLBS = [
  { file: "atelier.glb", max: 3_145_728 },
  { file: "atelier-mobile.glb", max: 1_572_864 },
] as const;
const SKY_MAX = 307_200;

const load = (file: string) =>
  readGlbJson(new Uint8Array(fs.readFileSync(path.join(ASSETS, file))));
const names = (file: string) =>
  new Set((load(file).nodes ?? []).map((n) => n.name));

describe.each(GLBS)("$file", ({ file, max }) => {
  describe("正常系", () => {
    it("PROPS の node・anchor がすべてノードにある", () => {
      const n = names(file);
      for (const p of Object.values(PROPS)) {
        expect(n, p.node).toContain(p.node);
        expect(n, p.anchor).toContain(p.anchor);
      }
    });

    it("STILL_VIEWS の camera がすべてカメラ付きのノードにある", () => {
      const nodes = load(file).nodes ?? [];
      for (const view of Object.values(STILL_VIEWS)) {
        const node = nodes.find((x) => x.name === view.camera);
        expect(node, view.camera).toBeDefined();
        expect(node?.camera, view.camera).toBeTypeOf("number");
      }
    });

    it("rail_ が 2 本以上、番号が 00 から欠けずに続く", () => {
      const rails = [...names(file)]
        .filter((x): x is string => !!x && /^rail_\d{2}$/.test(x))
        .sort();
      expect(rails.length).toBeGreaterThanOrEqual(2);
      rails.forEach((r, i) =>
        expect(r).toBe(`rail_${String(i).padStart(2, "0")}`),
      );
    });

    it("frame_00〜frame_06・avatar_spot・skylight_glass・lamp_00 がある", () => {
      const n = names(file);
      for (let i = 0; i < FRAME_SLOTS; i++)
        expect(n).toContain(`frame_${String(i).padStart(2, "0")}`);
      for (const x of ["avatar_spot", "skylight_glass", "lamp_00"])
        expect(n).toContain(x);
    });

    it("画像はすべて image/webp", () => {
      const images = load(file).images ?? [];
      expect(images.length).toBeGreaterThan(0);
      for (const image of images) expect(image.mimeType).toBe("image/webp");
    });

    it(`ファイルは ${max.toLocaleString()} バイト以内`, () => {
      expect(fs.statSync(path.join(ASSETS, file)).size).toBeLessThanOrEqual(
        max,
      );
    });
  });
});

describe("sky", () => {
  describe("正常系", () => {
    it("sky の 3 枚はそれぞれ 307,200 バイト以内", () => {
      for (const phase of ["morning", "day", "dusk"]) {
        const file = path.join(ASSETS, "sky", `${phase}.webp`);
        expect(fs.statSync(file).size, phase).toBeLessThanOrEqual(SKY_MAX);
      }
    });
  });
});

describe("readGlbJson", () => {
  describe("異常系", () => {
    it("入力: glb でないファイルは readGlbJson が Error を投げる", () => {
      expect(() =>
        readGlbJson(new TextEncoder().encode("not a glb file at all")),
      ).toThrow(/glb/);
    });
  });
});

// 2026-10-29: 静止画の額が空白だった（板の UV の張り直しが高さの軸を見落としていた）。壁の静止画（accessibility）の
// 左端の額（「この体験そのもの」。文字を持つ）の中が一色でないこと＝額の絵（文字）が写っていることを確かめる。4 つの時間帯すべて
describe("stills の額", () => {
  describe("正常系", () => {
    it.each(["morning", "day", "dusk", "night"])("accessibility-%s の左端の額に文字が写る（一色でない）", async (phase) => {
      const { default: sharp } = await import("sharp");
      const file = path.join(ASSETS, "stills", `accessibility-${phase}.webp`);
      // 1440×810 の絵の左端の額の内側（枠を除く）。stats() は入力の画像を測るので、切り出した絵を作り直してから測る
      const crop = await sharp(file).extract({ left: 50, top: 300, width: 140, height: 180 }).greyscale().png().toBuffer();
      const { channels } = await sharp(crop).stats();
      expect(channels[0].stdev).toBeGreaterThan(8);
    });
  });
});

// 2026-10-30: 左の道（route.ts の LEFT_LANE_DX）が、glb の rail_NN の数と合い、アバター（avatar_spot）と左の壁沿いの置き物を通り抜けない
describe("左の道", () => {
  describe("正常系", () => {
    it("LEFT_LANE_DX の数は rail_NN の数と同じ。左の道はアバターから 0.8m 以上、左の置き物から 1.2m 以上離れる（床の上の距離）", async () => {
      const { LEFT_LANE_DX, createRail } = await import("@/modules/atelier/client");
      // GlbJson の型は名前とカメラだけを持つので、位置（translation）を足した形で読む
      type Node = { name?: string; translation?: [number, number, number] };
      const nodes = (load("atelier.glb").nodes ?? []) as Node[];
      const node = (name: string) => nodes.find((n) => n.name === name)!;
      const rails = nodes
        .filter((n) => /^rail_\d+$/.test(n.name ?? ""))
        .sort((a, b) => (a.name! < b.name! ? -1 : 1))
        .map((n) => n.translation!);
      expect(rails.length).toBe(LEFT_LANE_DX.length);
      const rail = createRail(rails, [], LEFT_LANE_DX);
      const floor = (n: string) => {
        const t = node(n).translation!;
        return [t[0], t[2]] as const;
      };
      const obstacles = [
        { name: "avatar_spot", min: 0.8 },
        ...["prop_nameplate", "prop_consulting", "prop_envSetup", "prop_pricing"].map((name) => ({ name, min: 1.2 })),
      ];
      for (let i = 0; i <= 200; i++) {
        const p = rail.at(i / 200, 1).position;
        for (const o of obstacles) {
          const [x, z] = floor(o.name);
          expect(Math.hypot(p[0] - x, p[2] - z), `${o.name}（t=${i / 200}）`).toBeGreaterThanOrEqual(o.min);
        }
      }
    });
  });
});
