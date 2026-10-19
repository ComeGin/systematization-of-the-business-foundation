import { describe, expect, it } from "vitest";
import {
  applyMetaLicense,
  planTextureSize,
  sparseFromDense,
} from "@/modules/avatar/tools/slim-vrm.mjs";

// slim-vrm の純粋な関数だけを見る（GLB の読み書きと sharp は CLI の実行と読み直しの検証で確かめる）。

describe("planTextureSize", () => {
  describe("正常系", () => {
    it("長い辺を max に収め、縦横比を保つ（2048×1024 → 1024×512）", () => {
      expect(planTextureSize(2048, 1024, 1024)).toEqual({
        width: 1024,
        height: 512,
      });
    });

    it("縦長でも長い辺（高さ）を基準にする（1024×2048 → 512×1024）", () => {
      expect(planTextureSize(1024, 2048, 1024)).toEqual({
        width: 512,
        height: 1024,
      });
    });

    it("max 以下のものは変えない（512×512）", () => {
      expect(planTextureSize(512, 512, 1024)).toEqual({
        width: 512,
        height: 512,
      });
    });

    it("縮めた結果の短い辺は 1px より小さくしない（4096×2 → 1024×1）", () => {
      expect(planTextureSize(4096, 2, 1024)).toEqual({
        width: 1024,
        height: 1,
      });
    });
  });

  describe("異常系", () => {
    it("空入力: 0×0 は throw", () => {
      expect(() => planTextureSize(0, 0, 1024)).toThrow();
    });

    it("入力: 幅が 0 以下なら throw", () => {
      expect(() => planTextureSize(-1, 512, 1024)).toThrow();
    });

    it("入力: 高さが 0 以下なら throw", () => {
      expect(() => planTextureSize(512, 0, 1024)).toThrow();
    });

    it("入力: max が 0 以下なら throw", () => {
      expect(() => planTextureSize(512, 512, 0)).toThrow();
    });
  });
});

describe("applyMetaLicense", () => {
  describe("正常系", () => {
    it("VRM 1.0（VRMC_vrm.meta）は作者だけ・再配布不可・個人の非営利にし、ほかのキーは保つ", () => {
      const json = {
        asset: { version: "2.0" },
        extensions: {
          VRMC_vrm: {
            specVersion: "1.0",
            meta: {
              name: "ginta",
              authors: ["ComeGin"],
              avatarPermission: "everyone",
              allowRedistribution: true,
              commercialUsage: "corporation",
              licenseUrl: "https://vrm.dev/licenses/1.0/",
            },
            humanoid: { humanBones: {} },
          },
        },
      };
      const out = applyMetaLicense(json) as typeof json;
      expect(out.extensions.VRMC_vrm.meta).toEqual({
        name: "ginta",
        authors: ["ComeGin"],
        avatarPermission: "onlyAuthor",
        allowRedistribution: false,
        commercialUsage: "personalNonProfit",
        licenseUrl: "https://vrm.dev/licenses/1.0/",
      });
      expect(out.extensions.VRMC_vrm.humanoid).toEqual({ humanBones: {} });
      expect(out.asset).toEqual({ version: "2.0" });
    });

    it("VRM 0.x（VRM.meta）は OnlyAuthor・商用不可・再配布禁止にし、ほかのキーは保つ", () => {
      const json = {
        extensions: {
          VRM: {
            specVersion: "0.0",
            meta: {
              title: "ginta_kameya",
              author: "ComeGin",
              allowedUserName: "Everyone",
              commercialUssageName: "Allow",
              licenseName: "CC0",
              texture: 23,
            },
          },
        },
      };
      const out = applyMetaLicense(json) as typeof json;
      expect(out.extensions.VRM.meta).toEqual({
        title: "ginta_kameya",
        author: "ComeGin",
        allowedUserName: "OnlyAuthor",
        commercialUssageName: "Disallow",
        licenseName: "Redistribution_Prohibited",
        texture: 23,
      });
      expect(out.extensions.VRM.specVersion).toBe("0.0");
    });

    it("入力のオブジェクトは書き換えない（新しいオブジェクトを返す）", () => {
      const json = {
        extensions: { VRM: { meta: { allowedUserName: "Everyone" } } },
      };
      applyMetaLicense(json);
      expect(json.extensions.VRM.meta.allowedUserName).toBe("Everyone");
    });
  });

  describe("異常系", () => {
    it("空入力: applyMetaLicense({}) は {} のまま", () => {
      expect(applyMetaLicense({})).toEqual({});
    });

    it("入力: VRM の拡張に meta が無ければ何も足さない", () => {
      const json = { extensions: { VRM: { specVersion: "0.0" } } };
      expect(applyMetaLicense(json)).toEqual({
        extensions: { VRM: { specVersion: "0.0" } },
      });
    });
  });
});

describe("sparseFromDense", () => {
  describe("正常系", () => {
    it("0 でない要素（3 つ組のどれかが 0 でない頂点）だけを番号つきで取り出す", () => {
      const dense = new Float32Array([0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, -0.25, 1]);
      const sparse = sparseFromDense(dense, 3);
      expect(sparse.indices).toEqual([1, 3]);
      expect(sparse.values).toEqual([0.5, 0, 0, 0, -0.25, 1]);
    });

    it("取り出したものを 0 の配列に書き戻すと元と同じになる（ロスレス）", () => {
      const dense = new Float32Array([0.1, 0.2, 0.3, 0, 0, 0, 1e-7, 0, 0]);
      const { indices, values } = sparseFromDense(dense, 3);
      const restored = new Float32Array(dense.length);
      indices.forEach((index, i) => restored.set(values.slice(i * 3, i * 3 + 3), index * 3));
      expect(Array.from(restored)).toEqual(Array.from(dense));
    });
  });

  describe("異常系", () => {
    it("空入力: 空の配列は indices も values も空", () => {
      expect(sparseFromDense(new Float32Array(0), 3)).toEqual({ indices: [], values: [] });
    });

    it("入力: すべて 0 なら indices は空", () => {
      expect(sparseFromDense(new Float32Array(6), 3).indices).toEqual([]);
    });

    it("入力: 長さが itemSize の倍数でなければ throw", () => {
      expect(() => sparseFromDense(new Float32Array(4), 3)).toThrow();
    });
  });
});
