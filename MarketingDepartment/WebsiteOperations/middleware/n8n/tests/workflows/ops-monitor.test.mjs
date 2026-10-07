// ops-monitor（運用監視。TA-05 の項目 9・5）の判定のロジック。
// Code ノード「期限が最も近い証明書の残り日数」（PEM から notAfter を取り出す）と、Edit Fields・IF の式を動かして確かめる。
// 証明書は openssl req -x509 で作った自己署名のもの（秘密鍵は捨てた。公開部分だけ）。期待する期限は Node の X509Certificate で読み、
// Code ノードの自作の DER の読み取りと突き合わせる。実際のファイル・OpenSEO には繋がない。
import { X509Certificate } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalIfLeft, evalSetNode, getNode, loadWorkflow, referencedNodeNames, runCodeNode } from "../helpers/workflow.mjs";

const wf = loadWorkflow("ops-monitor.json");
const CODE = getNode(wf, "期限が最も近い証明書の残り日数");
const CERT_STATE = getNode(wf, "証明書の状態を決める");
const OPENSEO_STATE = getNode(wf, "OpenSEO の状態を決める");

// notAfter = 2027-11-11T08:04:12Z（UTCTime）
const CERT_2027 = `-----BEGIN CERTIFICATE-----
MIIBizCCATGgAwIBAgIUXEi12daCYVk9Jah14Vuj25HKOK8wCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQc2FuZGJveC10bHMtdGVzdDAeFw0yNjEwMDcwODA0MTJaFw0y
NzExMTEwODA0MTJaMBsxGTAXBgNVBAMMEHNhbmRib3gtdGxzLXRlc3QwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAQfFPj8+0MhURtfLeu/4HddW0Jyo1B3VfZtiGeY
0xjZybtDI3j5Iv6H74YSZCCRnwjQ6oMdM2x9wF5Vm6BhD6eao1MwUTAdBgNVHQ4E
FgQUyPn+4x6+aR9FrL/AkxzWBlCuK/4wHwYDVR0jBBgwFoAUyPn+4x6+aR9FrL/A
kxzWBlCuK/4wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiAEijpp
oGlgluRW5j30UZxQMAuXPH49y7Q53koTCBRHVAIhAIli0JCabYX598rJdmyLKLCa
+7kaYT8MV5QMd90p7S60
-----END CERTIFICATE-----
`;

// notAfter = 2051-12-15T08:04:12Z（2050 年以降なので GeneralizedTime）
const CERT_2051 = `-----BEGIN CERTIFICATE-----
MIIBljCCAT2gAwIBAgIUd4V8JuhLCtF6+ryN1nTiI2xob5AwCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVc2FuZGJveC10bHMtdGVzdC0yMDUwMCAXDTI2MTAwNzA4MDQx
MloYDzIwNTExMjE1MDgwNDEyWjAgMR4wHAYDVQQDDBVzYW5kYm94LXRscy10ZXN0
LTIwNTAwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQeb/m30geSrA9m+818b5Xn
UumDwkhLSeiRHG8NB0/q3XfuwcjoAAevbBWlILA1mKTgTuU8WCqMRe/oBHiJfZxV
o1MwUTAdBgNVHQ4EFgQUPqz8TtUuVWChtwlZ3UGSIfJTolowHwYDVR0jBBgwFoAU
Pqz8TtUuVWChtwlZ3UGSIfJTolowDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AgNHADBEAiAAh7zRQo887mG9eAKiz/RYtvzwsq1pHhwSawZpnnQUZAIgD4hIKiNP
TG//b0j800w2mt22yreSlCK4Xj6dSXTTXw0=
-----END CERTIFICATE-----
`;

const NOT_AFTER_2027 = Date.parse(new X509Certificate(CERT_2027).validTo);
const NOT_AFTER_2051 = Date.parse(new X509Certificate(CERT_2051).validTo);
const NOW = new Date("2027-10-01T00:00:00Z");
const DAY = 86_400_000;

/** 証明書の時刻の部分だけを持つ DER（SEQUENCE の中に notBefore・notAfter を並べる）を PEM にする。tag は 0x17（UTCTime）か 0x18（GeneralizedTime） */
function fakePem(times) {
  const parts = [Buffer.from([0x02, 0x01, 0x01])];
  for (const [tag, text] of times) parts.push(Buffer.from([tag, text.length]), Buffer.from(text, "latin1"));
  const inner = Buffer.concat(parts);
  const der = Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----\n`;
}

/** 「証明書を文字列にする」（Extract From File の text。destinationKey は pem）の出力の形で Code ノードを動かす */
const runCert = (items) => runCodeNode(CODE, { input: items }).then((out) => out.map((i) => i.json));
const pemItem = (pem) => ({ json: { pem } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("期限が最も近い証明書の残り日数（Code）", () => {
  describe("正常系", () => {
    it("Run Once for All Items の JavaScript で、ほかのノードを $() で参照しない（直前の入力だけを読む）", () => {
      expect(CODE.parameters).toMatchObject({ mode: "runOnceForAllItems", language: "javaScript" });
      expect(referencedNodeNames(CODE.parameters.jsCode)).toEqual([]);
    });

    it("PEM から notAfter を読み、残り日数（切り捨て）と JST の日付を返す（Node の X509Certificate の読みと一致する）", async () => {
      expect(await runCert([pemItem(CERT_2027)])).toEqual([
        { count: 1, daysLeft: Math.floor((NOT_AFTER_2027 - NOW.getTime()) / DAY), notAfter: "2027-11-11" },
      ]);
    });

    it("2050 年以降の期限（GeneralizedTime）も読む", async () => {
      const [r] = await runCert([pemItem(CERT_2051)]);
      expect(r.daysLeft).toBe(Math.floor((NOT_AFTER_2051 - NOW.getTime()) / DAY));
      expect(r.notAfter).toBe("2051-12-15");
    });

    it("複数の証明書は、期限が最も近いものの日数を返し、読めた枚数を count にする", async () => {
      const [r] = await runCert([pemItem(CERT_2051), pemItem(CERT_2027)]);
      expect(r).toMatchObject({ count: 2, notAfter: "2027-11-11" });
    });

    it("UTCTime の年の 2 桁が 50 以上なら 19xx 年、49 以下なら 20xx 年として読む（RFC 5280）", async () => {
      const [old] = await runCert([pemItem(fakePem([[0x17, "500101000000Z"], [0x17, "991231000000Z"]]))]);
      expect(old.notAfter).toBe("1999-12-31");
      const [recent] = await runCert([pemItem(fakePem([[0x17, "260101000000Z"], [0x17, "491231000000Z"]]))]);
      expect(recent.notAfter).toBe("2049-12-31");
    });

    it("表示の日付は JST にする（UTC で前日の 15:00 以降は翌日の日付）", async () => {
      const [r] = await runCert([pemItem(fakePem([[0x17, "270101000000Z"], [0x17, "271231150000Z"]]))]);
      expect(r.notAfter).toBe("2028-01-01");
    });

    it("期限ちょうど 30 日前は 30 日、29 日と 23 時間前は 29 日（切り捨て）", async () => {
      const at = (ms) => {
        vi.setSystemTime(new Date(ms));
        return runCert([pemItem(CERT_2027)]).then(([r]) => r.daysLeft);
      };
      expect(await at(NOT_AFTER_2027 - 30 * DAY)).toBe(30);
      expect(await at(NOT_AFTER_2027 - 30 * DAY + 3_600_000)).toBe(29);
    });

    it("空入力: 入力が 0 件（証明書のファイルが 1 つも無い）なら count: 0 を 1 件返す（次のノードで ng にする）", async () => {
      expect(await runCert([])).toEqual([{ count: 0, daysLeft: null, notAfter: "" }]);
    });

    it("空入力: pem が空文字・無い項目は数えない", async () => {
      expect(await runCert([pemItem(""), { json: {} }, pemItem(CERT_2027)])).toEqual([expect.objectContaining({ count: 1, notAfter: "2027-11-11" })]);
    });
  });

  describe("異常系", () => {
    it("入力: 期限を過ぎた証明書は、残り日数を負の数で返す", async () => {
      vi.setSystemTime(new Date(NOT_AFTER_2027 + 3 * DAY));
      const [r] = await runCert([pemItem(CERT_2027)]);
      expect(r.daysLeft).toBe(-3);
    });

    it("入力: 証明書でない文字列（base64 でない・時刻が無い）は読み飛ばし、例外にしない", async () => {
      expect(await runCert([pemItem("not a certificate"), pemItem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----")])).toEqual([
        { count: 0, daysLeft: null, notAfter: "" },
      ]);
    });

    it("入力: 壊れた証明書と正しい証明書が混ざっていれば、正しいものだけを数える", async () => {
      const [r] = await runCert([pemItem("garbage"), pemItem(CERT_2027)]);
      expect(r).toMatchObject({ count: 1, notAfter: "2027-11-11" });
    });

    it("入力: 時刻が 1 つしかない（notAfter が無い）・途中で切れている DER は読み飛ばす", async () => {
      expect(await runCert([pemItem(fakePem([[0x17, "260101000000Z"]]))])).toEqual([{ count: 0, daysLeft: null, notAfter: "" }]);
      const truncated = Buffer.from(fakePem([[0x17, "260101000000Z"], [0x17, "271231000000Z"]]).replace(/-----[^-]+-----|\s/g, ""), "base64").subarray(0, 20);
      expect(await runCert([pemItem(truncated.toString("base64"))])).toEqual([{ count: 0, daysLeft: null, notAfter: "" }]);
    });

    it("入力: 長さが UTCTime・GeneralizedTime の決まり（13・15 バイト）と違う時刻は読まない", async () => {
      expect(await runCert([pemItem(fakePem([[0x17, "2601010000Z"], [0x17, "2712310000Z"]]))])).toEqual([{ count: 0, daysLeft: null, notAfter: "" }]);
    });

    it("サーバ: ファイルの読み取り・文字列化が失敗した項目（onError で error だけを持つ）は数えない", async () => {
      expect(await runCert([{ json: { error: { message: "ENOENT: no such file or directory" } } }])).toEqual([{ count: 0, daysLeft: null, notAfter: "" }]);
    });
  });
});

describe("証明書の状態を決める（Edit Fields）", () => {
  const decide = (json) => evalSetNode(CERT_STATE, { json });

  describe("正常系", () => {
    it("残り 30 日以上なら ok で、内訳に最短の期限までの日数と日付を入れる", () => {
      expect(decide({ count: 2, daysLeft: 30, notAfter: "2027-11-11" })).toEqual({ state: "ok", detail: "最短の期限まで 30 日（2027-11-11）" });
      expect(decide({ count: 1, daysLeft: 400, notAfter: "2028-11-11" }).state).toBe("ok");
    });

    it("Code ノードの出力をそのまま渡すと判定できる（つながりの確認）", async () => {
      const [json] = await runCert([pemItem(CERT_2027)]);
      expect(decide(json)).toEqual({ state: "ok", detail: `最短の期限まで ${json.daysLeft} 日（2027-11-11）` });
    });
  });

  describe("異常系", () => {
    it("入力: 残り 29 日以下なら ng（TA-05 の項目 5 のしきい値）", () => {
      expect(decide({ count: 1, daysLeft: 29, notAfter: "2027-11-11" }).state).toBe("ng");
    });

    it("入力: 期限切れ（負の日数）なら ng", () => {
      expect(decide({ count: 1, daysLeft: -1, notAfter: "2027-11-11" })).toEqual({ state: "ng", detail: "最短の期限まで -1 日（2027-11-11）" });
    });

    it("空入力: 証明書を 1 つも読めない（count: 0）なら ng で、マウントを確かめる案内を入れる", () => {
      expect(decide({ count: 0, daysLeft: null, notAfter: "" })).toEqual({ state: "ng", detail: "証明書を読めない（sandbox-tls の public マウントを確認する）" });
    });

    it("空入力: 項目が空（{}）でも例外にせず ng にする", () => {
      expect(decide({}).state).toBe("ng");
    });
  });
});

describe("OpenSEO の状態を決める（Edit Fields）", () => {
  const decide = (json) => evalSetNode(OPENSEO_STATE, { json });

  describe("正常系", () => {
    it("health が status: ok なら ok で、内訳は空", () => {
      expect(decide({ status: "ok", checks: { db: { status: "ok" } } })).toEqual({ state: "ok", detail: "" });
    });
  });

  describe("異常系", () => {
    it("サーバ: 接続できない・タイムアウト・5xx（HTTP ノードの onError で error だけが来る）なら ng で、起動と host-relay を確かめる案内を入れる", () => {
      expect(decide({ error: { message: "connect ECONNREFUSED", code: "ECONNREFUSED" } })).toEqual({
        state: "ng",
        detail: "応答なし（OpenSEO が起動しているか、host-relay が動いているかを確認する）",
      });
    });

    it("サーバ: status が ok 以外なら ng で、error になっている検査の名前だけを並べる", () => {
      const r = decide({ status: "degraded", checks: { db: { status: "error" }, redis: { status: "ok" }, dataforseo: { status: "error", message: "key=xxx" } } });
      expect(r).toEqual({ state: "ng", detail: "error の項目: db, dataforseo" });
      // 検査の message（キーなどが入りうる）は内訳に載せない
      expect(r.detail).not.toContain("key=xxx");
    });

    it("サーバ: 想定外の形の応答（checks が無い・null の検査がある）でも例外にせず、項目は「不明」にする", () => {
      expect(decide({ status: "error" })).toEqual({ state: "ng", detail: "error の項目: 不明" });
      expect(decide({ status: "error", checks: { db: null } })).toEqual({ state: "ng", detail: "error の項目: 不明" });
    });

    it("空入力: 応答の本文が空（{}）なら ng", () => {
      expect(decide({})).toEqual({ state: "ng", detail: "error の項目: 不明" });
    });
  });
});

describe("監視のスイッチ（IF の左辺。ops_settings の opsMonitorEnabled）", () => {
  const gates = [
    ["監視が有効か（OpenSEO）", "設定を読む（OpenSEO）"],
    ["監視が有効か（証明書）", "設定を読む（証明書）"],
  ];
  const left = (gate, settingsNode, rows) => evalIfLeft(getNode(wf, gate), { nodes: { [settingsNode]: rows.map((json) => ({ json })) } });

  describe("正常系", () => {
    it.each(gates)("%s: 行の値が 'true' なら 'true'（IF の右辺と一致して先へ進む）", (gate, settingsNode) => {
      expect(left(gate, settingsNode, [{ key: "notifyBackend", value: "mailhog" }, { key: "opsMonitorEnabled", value: "true" }])).toBe("true");
    });

    it.each(gates)("%s: IF は 1 回だけ判定する（executeOnce。設定の行の数だけ監視しない）", (gate) => {
      expect(getNode(wf, gate).executeOnce).toBe(true);
    });
  });

  describe("異常系", () => {
    it.each(gates)("空入力: %s: ops_settings が 0 行ならスイッチは 'false'（既定で止まっている）", (gate, settingsNode) => {
      expect(left(gate, settingsNode, [])).toBe("false");
    });

    it.each(gates)("入力: %s: 'false'・'TRUE' など 'true' 以外の値では進まない（大文字小文字を区別する）", (gate, settingsNode) => {
      const node = getNode(wf, gate);
      expect(node.parameters.conditions.options.caseSensitive).toBe(true);
      for (const value of ["false", "TRUE", "1", ""]) expect(left(gate, settingsNode, [{ key: "opsMonitorEnabled", value }])).not.toBe("true");
    });
  });
});
