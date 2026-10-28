import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGE_VIEWS, PARTS, readGlbJson } from "@/modules/diorama/client";

// 模型の glb（src/modules/diorama/assets/diorama.glb。Blender で作った正本の書き出し）が、コードの約束どおりのノードを持つか。
// glb の JSON チャンクだけを読む（three は使わない）。ノード名の約束は計画 Task 4 の Produces。

const GLB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/modules/diorama/assets/diorama.glb",
);
const MAX_BYTES = 1_572_864;

const load = () => readGlbJson(new Uint8Array(fs.readFileSync(GLB)));
const nodeNames = () => new Set((load().nodes ?? []).map((n) => n.name));

describe("diorama.glb", () => {
  describe("正常系", () => {
    it("PARTS の node・anchor・shadow（null 以外）がすべてノードにある", () => {
      const names = nodeNames();
      for (const part of Object.values(PARTS)) {
        expect(names, part.node).toContain(part.node);
        expect(names, part.anchor).toContain(part.anchor);
        if (part.shadow) expect(names, part.shadow).toContain(part.shadow);
      }
    });

    it("PAGE_VIEWS の camera がすべてカメラ付きのノードにある", () => {
      const nodes = load().nodes ?? [];
      for (const view of Object.values(PAGE_VIEWS)) {
        const node = nodes.find((n) => n.name === view.camera);
        expect(node, view.camera).toBeDefined();
        expect(node?.camera, view.camera).toBeTypeOf("number");
      }
    });

    it("lamp・avatar_spot がある", () => {
      const names = nodeNames();
      expect(names).toContain("lamp");
      expect(names).toContain("avatar_spot");
    });

    it("画像はすべて image/webp", () => {
      const images = load().images ?? [];
      expect(images.length).toBeGreaterThan(0);
      for (const image of images) expect(image.mimeType).toBe("image/webp");
    });

    it("ファイルは 1,572,864 バイト以内", () => {
      expect(fs.statSync(GLB).size).toBeLessThanOrEqual(MAX_BYTES);
    });
  });

  describe("異常系", () => {
    it("入力: glb でないファイル（先頭が glTF でない）は読めないと分かる", () => {
      expect(() =>
        readGlbJson(new TextEncoder().encode("not a glb file at all")),
      ).toThrow(/glb/);
    });
  });

  it("空入力: 0 バイトは読めないと分かる", () => {
    expect(() => readGlbJson(new Uint8Array())).toThrow(/glb/);
  });
});
