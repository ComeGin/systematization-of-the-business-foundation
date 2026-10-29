import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionClipJson } from "@/modules/avatar/lib/types";

// 代表の人形（lib/figure.ts）の身ぶり（spec §6.4。計画 Task 5）。押すと名前の身ぶりを 1 回だけ再生し、終わると待機に戻る。
// 再生中に押されたら、今の身ぶりが終わってから次を再生する。three は実物（AnimationMixer は WebGL なしで動く）、
// VRM の読み込み（three-vrm・GLTFLoader）と fetch は偽物にする。

const hips = new THREE.Object3D();
hips.name = "Normalized_hips";
hips.position.y = 1;
const fakeScene = new THREE.Object3D();
fakeScene.add(hips);
const fakeVrm = {
  scene: fakeScene,
  humanoid: {
    getNormalizedBoneNode: (name: string) => (name === "hips" ? hips : null),
  },
  meta: { metaVersion: "1" as const },
  update: () => {},
};

vi.mock("@pixiv/three-vrm", () => ({
  VRMLoaderPlugin: class {},
  VRMUtils: {
    removeUnnecessaryVertices: () => {},
    combineSkeletons: () => {},
    rotateVRM0: () => {},
    deepDispose: () => {},
  },
}));
vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    register() {}
    loadAsync() {
      return Promise.resolve({ scene: fakeScene, userData: { vrm: fakeVrm } });
    }
  },
}));

const clip = (name: MotionClipJson["name"], duration: number): MotionClipJson => ({
  version: 1,
  name,
  duration,
  fps: 24,
  mixamoHipsHeight: 1,
  tracks: [
    {
      bone: "hips",
      path: "position",
      times: [0, duration],
      values: [0, 1, 0, 0, 1, 0],
    },
  ],
});

const CLIPS: Record<string, MotionClipJson> = {
  "/idle.json": clip("idle", 2),
  "/greeting.json": clip("greeting", 0.5),
  "/nod.json": clip("nod", 0.4),
  "/think.json": clip("think", 0.6),
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      CLIPS[url]
        ? { ok: true, status: 200, json: () => Promise.resolve(CLIPS[url]) }
        : {
            ok: false,
            status: 404,
            json: () => Promise.reject(new Error("not found")),
          },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** sec 秒ぶん、0.05 秒ずつ進める（途中で Promise の続きを走らせる） */
async function advance(figure: { update(dt: number): void }, sec: number) {
  for (let t = 0; t < sec; t += 0.05) {
    figure.update(0.05);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const create = async (clipUrls: Record<string, string>) => {
  const { createAvatarFigure } = await import("@/modules/avatar/lib/figure");
  return createAvatarFigure(THREE, {
    modelUrl: "/avatar.vrm",
    idleUrl: "/idle.json",
    clipUrls,
  });
};

describe("createAvatarFigure", () => {
  describe("正常系", () => {
    it("play で指定のクリップを 1 回だけ再生し、終わると待機に戻って Promise が解決する", async () => {
      const figure = await create({ greeting: "/greeting.json" });
      let done = false;
      const p = figure.play("greeting").then(() => (done = true));
      await advance(figure, 0.2);
      expect(figure.playing).toBe(true);
      expect(done).toBe(false);
      await advance(figure, 0.6);
      await p;
      expect(done).toBe(true);
      expect(figure.playing).toBe(false);
    });

    it("再生中に play を呼ぶと、今のクリップが終わってから次を再生する", async () => {
      const figure = await create({
        greeting: "/greeting.json",
        think: "/think.json",
      });
      const order: string[] = [];
      const first = figure.play("greeting").then(() => order.push("greeting"));
      await advance(figure, 0.1);
      const second = figure.play("think").then(() => order.push("think"));
      await advance(figure, 0.6);
      // greeting（0.5 秒）が終わった時点では、think（0.6 秒）はまだ終わっていない
      expect(order).toEqual(["greeting"]);
      expect(figure.playing).toBe(true);
      await advance(figure, 0.8);
      await Promise.all([first, second]);
      expect(order).toEqual(["greeting", "think"]);
    });

    it("clipUrls のクリップは最初の play の前に読み込みを始める", async () => {
      await create({ greeting: "/greeting.json", think: "/think.json" });
      const urls = fetchMock.mock.calls.map(([url]) => url);
      expect(urls).toEqual(
        expect.arrayContaining(["/idle.json", "/greeting.json", "/think.json"]),
      );
    });
  });

  describe("異常系", () => {
    it("サーバ: クリップの取得が 404 なら play は reject し、待機のまま", async () => {
      const figure = await create({ peace: "/missing.json" });
      await expect(figure.play("peace")).rejects.toThrow(/404/);
      expect(figure.playing).toBe(false);
    });

    it("入力: clipUrls に無い名前の play は reject", async () => {
      const figure = await create({ greeting: "/greeting.json" });
      await expect(figure.play("point")).rejects.toThrow(/point/);
      expect(figure.playing).toBe(false);
    });

    it("空入力: clipUrls が空でも作れて、待機だけ", async () => {
      const figure = await create({});
      expect(figure.object).toBe(fakeScene);
      await advance(figure, 0.2);
      expect(figure.playing).toBe(false);
    });
  });
});
