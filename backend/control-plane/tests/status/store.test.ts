import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialNotifyLedger } from "../../src/status/notify.js";
import { StatusStore, type StoredStatus } from "../../src/status/store.js";
import { tempDir } from "../helpers/runner.js";

let root: string;
let cleanup: () => void;
beforeEach(() => {
  ({ dir: root, cleanup } = tempDir("cp-status-store-"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => cleanup());

const sample = (): StoredStatus => ({
  version: 1,
  snapshot: {
    checkedAt: "2026-11-03T10:00:00.000+09:00",
    counts: { ok: 1, action: 0, warn: 0, manual: 0, unknown: 0 },
    steps: [
      {
        id: "P1",
        title: "段階 env",
        level: "ok",
        items: [
          {
            id: "P1.tools",
            title: "道具",
            who: "人・端末",
            kind: "検査",
            level: "ok",
            evidence: "そろっている",
            stopId: "cloud:env",
            docs: [{ file: "cloud/README.md", heading: "2" }],
            checkedAt: "2026-11-03T10:00:00.000+09:00",
          },
        ],
      },
    ],
  },
  moduleResults: [
    {
      moduleId: "cloud",
      phase: "env",
      ok: true,
      notes: [],
      items: [{ key: "cloud.dmarc", step: "P4", level: "ok", title: "", evidence: "" }],
      error: null,
      skipped: false,
      checkedAt: "2026-11-03T10:00:00.000+09:00",
      script: "setup/setup.mjs",
    },
  ],
  productApiCheckedAt: null,
  ledger: initialNotifyLedger(),
});

describe("StatusStore", () => {
  describe("正常系", () => {
    it("入力: 手順の一覧の数え（後から足した 2 項目）が無い古い保存も読め、あれば読み戻せる", () => {
      const store = new StatusStore(join(root, "data"));
      store.save(sample()); // 2 項目が無い形
      expect(store.load()?.ledger).toEqual(initialNotifyLedger());
      const withBroken = { ...sample(), ledger: { ...initialNotifyLedger(), catalogBrokenSince: "2026-11-03T10:00:00.000+09:00", catalogBrokenNotified: true } };
      store.save(withBroken);
      expect(store.load()).toEqual(withBroken);
    });

    it("入力: 古い形の ? の数え（unknownSince・unknownNotified の 1 組）の保存も読め、項目 id ごとの数えを空から始める", () => {
      const store = new StatusStore(root);
      const { unknownItems: _drop, ...rest } = initialNotifyLedger();
      const old = { ...sample(), ledger: { ...rest, unknownSince: "2026-11-03T09:00:00.000+09:00", unknownNotified: true } };
      writeFileSync(store.file, JSON.stringify(old));
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.ledger).toEqual(initialNotifyLedger());
      expect(loaded!.ledger).not.toHaveProperty("unknownSince");
      expect(loaded!.ledger).not.toHaveProperty("unknownNotified");
    });

    it("入力: 項目 id ごとの ? の数えとずれの結果を読み戻せる（ずれの結果が無い古い保存も読める）", () => {
      const store = new StatusStore(join(root, "data"));
      const withItems: StoredStatus = {
        ...sample(),
        driftResults: [{ id: "n8n-workflows", level: "manual", evidence: "判断待ち", checkedAt: "2026-11-03T10:00:00.000+09:00" }],
        ledger: { ...initialNotifyLedger(), unknownItems: { "P1.a": { since: "2026-11-03T10:00:00.000+09:00", notified: true } } },
      };
      store.save(withItems);
      expect(store.load()).toEqual(withItems);
      store.save(sample());
      expect(store.load()?.driftResults).toBeUndefined();
    });

    it("入力: 保存したものを読み戻せる（置き場は無ければ作り、ファイルは 600）", () => {
      const dataDir = join(root, "data");
      const store = new StatusStore(dataDir);
      store.save(sample());
      expect(store.load()).toEqual(sample());
      expect(statSync(store.file).mode & 0o777).toBe(0o600);
      // 一時ファイルを残さない
      expect(readdirSync(dataDir)).toEqual(["setup-status.json"]);
    });

    it("入力: 2 回目の保存は上書きする", () => {
      const store = new StatusStore(root);
      store.save(sample());
      const next = { ...sample(), productApiCheckedAt: "2026-11-03T11:00:00.000+09:00" };
      store.save(next);
      expect(store.load()?.productApiCheckedAt).toBe("2026-11-03T11:00:00.000+09:00");
    });
  });

  describe("異常系", () => {
    it("空入力: ファイルが無ければ null", () => {
      const store = new StatusStore(root);
      expect(existsSync(store.file)).toBe(false);
      expect(store.load()).toBeNull();
    });

    it("入力: 壊れた JSON は null（投げない）", () => {
      const store = new StatusStore(root);
      writeFileSync(store.file, "{ broken");
      expect(store.load()).toBeNull();
    });

    it("入力: 形が違う（古い版）なら null", () => {
      const store = new StatusStore(root);
      writeFileSync(store.file, JSON.stringify({ ...sample(), version: 2 }));
      expect(store.load()).toBeNull();
    });
  });
});
