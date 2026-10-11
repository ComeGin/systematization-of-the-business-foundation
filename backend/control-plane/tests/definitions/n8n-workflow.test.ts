import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { N8N_WORKFLOWS_DIR } from "../../src/constants/paths.js";
import { assignFileNames, normalizeWorkflow, slugForName } from "../../src/definitions/n8n-workflow.js";
import { repositoryRoot } from "../helpers/store.js";

// 純粋関数だけ（入出力もネットワークも無い）なので、サーバ側の異常は無い。実在のファイルは読むだけ

/** n8n の Public API の単体取得の応答に近い形（揮発フィールドを含む）。 */
function apiWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    updatedAt: "2026-10-06T00:00:00.000Z",
    id: "wf1",
    name: "I-11 Mautic Webhook の受領と重複排除",
    active: true,
    isArchived: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    versionId: "v-1",
    activeVersionId: "v-1",
    versionCounter: 3,
    triggerCount: 1,
    shared: [{ role: "workflow:owner" }],
    staticData: { lastId: 3 },
    parentFolder: null,
    connections: { Webhook: { main: [[{ node: "B", type: "main", index: 0 }]] } },
    nodes: [
      {
        updatedAt: "2026-10-06T00:00:00.000Z",
        position: [0, 0],
        type: "n8n-nodes-base.webhook",
        name: "Webhook",
        parameters: { path: "mautic", httpMethod: "POST", options: { z: 1, a: 2 } },
        id: "n1",
        typeVersion: 2,
        createdAt: "2026-10-01T00:00:00.000Z",
        webhookId: "hook-1",
      },
    ],
    settings: { executionOrder: "v1", binaryMode: "filesystem", credentialResolverId: "r1", callerPolicy: "workflowsFromSameOwner" },
    pinData: { Webhook: [{ json: { email: "taro@example.com" } }] },
    meta: { instanceId: "instance-xyz", templateCredsSetupCompleted: true },
    tags: [{ id: "t2", name: "prod" }, { id: "t1", name: "inquiry" }],
    ...overrides,
  };
}

const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe("normalizeWorkflow", () => {
  describe("正常系", () => {
    it("揮発・派生のフィールドを除き、n8n の画面の書き出しの順にキーを並べる", () => {
      const out = parse(normalizeWorkflow(apiWorkflow()).text);
      expect(Object.keys(out)).toEqual(["name", "nodes", "connections", "active", "settings", "pinData", "meta", "tags"]);
      for (const key of ["id", "versionId", "activeVersionId", "updatedAt", "createdAt", "staticData", "shared", "triggerCount", "isArchived", "versionCounter", "parentFolder"]) {
        expect(out).not.toHaveProperty(key);
      }
    });

    it("ノードは決まった順に並べ、createdAt・updatedAt を除き、parameters の中はアルファベット順にする", () => {
      const out = parse(normalizeWorkflow(apiWorkflow()).text) as { nodes: Record<string, unknown>[] };
      expect(Object.keys(out.nodes[0]!)).toEqual(["parameters", "id", "name", "type", "typeVersion", "position", "webhookId"]);
      expect(Object.keys(out.nodes[0]!.parameters as object)).toEqual(["httpMethod", "options", "path"]);
      expect(Object.keys((out.nodes[0]!.parameters as { options: object }).options)).toEqual(["a", "z"]);
    });

    it("ノードの並びの外のキーは末尾にアルファベット順で置き、配列の順序は変えない", () => {
      const nodes = [
        { name: "B", zeta: 1, alwaysOutputData: true, id: "2" },
        { name: "A", id: "1", position: [2, 1] },
      ];
      const out = parse(normalizeWorkflow(apiWorkflow({ nodes })).text) as { nodes: Record<string, unknown>[] };
      expect(out.nodes.map((node) => node.name)).toEqual(["B", "A"]);
      expect(Object.keys(out.nodes[0]!)).toEqual(["id", "name", "alwaysOutputData", "zeta"]);
      expect(out.nodes[1]!.position).toEqual([2, 1]);
    });

    it("pinData は常に空のオブジェクトにし、ピン留めの値（個人情報を含みうる）を残さない", () => {
      const result = normalizeWorkflow(apiWorkflow());
      expect(parse(result.text).pinData).toEqual({});
      expect(result.text).not.toContain("taro@example.com");
    });

    it("settings から binaryMode・credentialResolverId を除き、meta から instanceId を除く", () => {
      const out = parse(normalizeWorkflow(apiWorkflow()).text);
      expect(out.settings).toEqual({ callerPolicy: "workflowsFromSameOwner", executionOrder: "v1" });
      expect(out.meta).toEqual({ templateCredsSetupCompleted: true });
    });

    it("tags は名前だけをアルファベット順に残す（名前の無いタグは落とす）", () => {
      const tags = [{ name: "prod" }, { id: "x" }, "raw", { name: "inquiry" }];
      expect(parse(normalizeWorkflow(apiWorkflow({ tags })).text).tags).toEqual(["inquiry", "prod"]);
    });

    it("公開の状態は本番の事実として残し、true 以外は false にする", () => {
      expect(normalizeWorkflow(apiWorkflow({ active: true }))).toMatchObject({ active: true });
      expect(parse(normalizeWorkflow(apiWorkflow({ active: true })).text).active).toBe(true);
      for (const active of [false, "true", 1, undefined]) {
        const result = normalizeWorkflow(apiWorkflow({ active }));
        expect(result.active).toBe(false);
        expect(parse(result.text).active).toBe(false);
      }
    });

    it("description は空でなければ残し、nodeGroups は空でなければ残す", () => {
      const out = parse(normalizeWorkflow(apiWorkflow({ description: "説明", nodeGroups: [{ id: "g" }] })).text);
      expect(out.description).toBe("説明");
      expect(out.nodeGroups).toEqual([{ id: "g" }]);
      expect(Object.keys(out).slice(-3)).toEqual(["description", "tags", "nodeGroups"]);
    });

    it("並びの外のトップレベルのキーは末尾にアルファベット順で置く", () => {
      const out = parse(normalizeWorkflow(apiWorkflow({ zz: 1, aa: { b: 1, a: 2 } })).text);
      expect(Object.keys(out).slice(-2)).toEqual(["aa", "zz"]);
      expect(Object.keys(out.aa as object)).toEqual(["a", "b"]);
    });

    it("インデント 2・末尾改行の JSON にする", () => {
      const { text } = normalizeWorkflow(apiWorkflow());
      expect(text.endsWith("}\n")).toBe(true);
      expect(text.split("\n")[1]).toMatch(/^ {2}"name": /);
    });

    it("入力のキーの順序が違っても同じバイト列になる", () => {
      const first = normalizeWorkflow(apiWorkflow());
      const shuffled = Object.fromEntries(Object.entries(apiWorkflow()).reverse());
      expect(normalizeWorkflow(shuffled).text).toBe(first.text);
    });

    it("tags の無いワークフローは、2 回かけても変わらない（冪等）", () => {
      // tags は API の形（{ id, name }）を名前の文字列にするため、書き出した後の文字列の tags は 2 回目で落ちる。
      // n8n-export は API の応答にだけかけるので、冪等性は tags の無いもの（既存のファイルはすべてそう）で確かめる
      const first = normalizeWorkflow(apiWorkflow({ tags: undefined }));
      expect(normalizeWorkflow(parse(first.text)).text).toBe(first.text);
    });

    it("name は NFC にして返す", () => {
      const nfd = "パイプライン"; // 半濁点を結合文字で書いた「パ」
      expect(normalizeWorkflow(apiWorkflow({ name: nfd })).name).toBe(nfd.normalize("NFC"));
    });

    it("nodes が配列でなくても落ちずに、キーを並べ替えて残す", () => {
      const out = parse(normalizeWorkflow(apiWorkflow({ nodes: { b: 1, a: 2 } })).text);
      expect(Object.keys(out.nodes as object)).toEqual(["a", "b"]);
    });

    it("空入力: name だけ（空文字）のワークフローは、active・pinData だけを補って整形する", () => {
      const result = normalizeWorkflow({ name: "" });
      expect(result).toEqual({ name: "", active: false, text: '{\n  "name": "",\n  "active": false,\n  "pinData": {}\n}\n', suspectedSecret: false });
    });

    it("空入力: 空の tags・meta・description・nodeGroups はキーごと除く", () => {
      const out = parse(
        normalizeWorkflow(apiWorkflow({ tags: [], meta: { instanceId: "x" }, description: "", nodeGroups: [] })).text,
      );
      for (const key of ["tags", "meta", "description", "nodeGroups"]) expect(out).not.toHaveProperty(key);
    });
  });

  describe("異常系", () => {
    it.each([
      ["null", null],
      ["配列", [{ name: "a" }]],
      ["文字列", "workflow"],
      ["name が数値", { name: 1 }],
      ["name が null", { name: null }],
    ])("入力: %s は形が想定と違うとして例外にする", (_label, raw) => {
      expect(() => normalizeWorkflow(raw)).toThrow("ワークフローの形が想定と違う（name が無い）");
    });

    it.each([
      ["undefined", undefined],
      ["空のオブジェクト", {}],
    ])("空入力: %s は name が無いとして例外にする", (_label, raw) => {
      expect(() => normalizeWorkflow(raw)).toThrow("name が無い");
    });
  });
});

describe("normalizeWorkflow の秘密値の検査（suspectedSecret）", () => {
  const withNode = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    normalizeWorkflow(apiWorkflow({ nodes: [{ name: "HTTP", type: "n8n-nodes-base.httpRequest", parameters, ...extra }] }));

  describe("正常系", () => {
    it("ふつうのワークフローは疑いなし", () => {
      expect(normalizeWorkflow(apiWorkflow()).suspectedSecret).toBe(false);
    });

    it("資格情報の参照（id と名前）は値ではないので疑わない", () => {
      const result = withNode({}, { credentials: { httpHeaderAuth: { id: "1", name: "Mautic API token" } } });
      expect(result.suspectedSecret).toBe(false);
    });

    it.each([
      ["式", { apiKey: "={{ $env.MAUTIC_API_KEY }}" }],
      ["URL", { accessTokenUrl: "https://auth.example.test/token" }],
      ["= 付きの URL", { tokenUrl: "=https://auth.example.test/token" }],
      ["空文字", { password: "" }],
      ["空白だけ", { secret: "   " }],
      ["数値", { tokenTtl: 3600 }],
      ["式の値のヘッダー", { headerParameters: { parameters: [{ name: "Authorization", value: "={{ 'Bearer ' + $json.token }}" }] } }],
      ["秘密でない名前のヘッダー", { headerParameters: { parameters: [{ name: "Content-Type", value: "application/json" }] } }],
    ])("%s は秘密値として疑わない", (_label, parameters) => {
      expect(withNode(parameters).suspectedSecret).toBe(false);
    });

    it("staticData・pinData の中の値は書き出さないので疑わない", () => {
      const result = normalizeWorkflow(apiWorkflow({ staticData: { token: "abc" }, pinData: { x: [{ json: { password: "p" } }] } }));
      expect(result.suspectedSecret).toBe(false);
    });

    it("空入力: ノードが無いワークフローは疑いなし", () => {
      expect(normalizeWorkflow(apiWorkflow({ nodes: [] })).suspectedSecret).toBe(false);
    });
  });

  describe("異常系", () => {
    it.each([
      ["GitHub のトークン", { url: "https://api.github.com", note: `ghp_${"a".repeat(36)}` }],
      ["GitHub の fine-grained トークン", { body: `github_pat_${"A1_".repeat(10)}` }],
      ["AWS のアクセスキー", { body: "AKIAABCDEFGHIJKLMNOP" }],
      ["Slack のトークン", { body: "xoxb-1234567890-abcdef" }],
      ["sk- のキー", { body: `sk-${"x".repeat(24)}` }],
      ["Bearer の値", { body: `Bearer ${"a".repeat(24)}` }],
      ["秘密鍵", { body: "-----BEGIN RSA PRIVATE KEY-----\nMII..." }],
    ])("入力: 値に %s の形があれば疑う", (_label, parameters) => {
      expect(withNode(parameters).suspectedSecret).toBe(true);
    });

    it.each([
      ["apiKey", { apiKey: "plain-value" }],
      ["api_key", { api_key: "plain-value" }],
      ["password", { password: "hunter2" }],
      ["clientSecret", { clientSecret: "abc" }],
      ["authorization", { Authorization: "Basic dXNlcjpwYXNz" }],
      ["= 付きの固定値", { token: "=plain-value" }],
    ])("入力: 秘密らしいキー（%s）に固定の文字列があれば疑う", (_label, parameters) => {
      expect(withNode(parameters).suspectedSecret).toBe(true);
    });

    it("入力: { name, value } の対で、秘密らしい名前のヘッダーに固定の値があれば疑う", () => {
      const parameters = { headerParameters: { parameters: [{ name: "X-API-Key", value: "abc123" }] } };
      expect(withNode(parameters).suspectedSecret).toBe(true);
    });

    it("入力: ノードの外（settings・meta）の固定の秘密値も疑う", () => {
      expect(normalizeWorkflow(apiWorkflow({ settings: { webhookSecret: "s" } })).suspectedSecret).toBe(true);
      expect(normalizeWorkflow(apiWorkflow({ meta: { note: `ghp_${"b".repeat(30)}` } })).suspectedSecret).toBe(true);
    });
  });
});

describe("slugForName", () => {
  describe("正常系", () => {
    it("I-xx で始まる名前は番号をそのまま残し、残りを kebab-case にする（英数字以外は落とす）", () => {
      expect(slugForName("I-11 Mautic Webhook の受領と重複排除", "wf1")).toBe("I-11-mautic-webhook");
      expect(slugForName("I-21 SNS 通知", "wf1")).toBe("I-21-sns");
    });

    it("I-xx の後ろに英数字が無ければ番号だけ", () => {
      expect(slugForName("I-12", "wf1")).toBe("I-12");
      expect(slugForName("I-19 突合", "wf1")).toBe("I-19");
    });

    it("それ以外は全体を kebab-case にし、全角英数は NFKC で半角にする", () => {
      expect(slugForName("Ops Monitor!!", "wf1")).toBe("ops-monitor");
      expect(slugForName("ＮＥＷ Flow ２", "wf1")).toBe("new-flow-2");
      expect(slugForName("n8n スケジュール実行のハートビート", "wf1")).toBe("n8n");
    });

    it("60 文字で切り、末尾の - を残さない", () => {
      const slug = slugForName(`${"a".repeat(59)} bcd`, "wf1");
      expect(slug).toBe("a".repeat(59));
      expect(slugForName("x".repeat(80), "wf1")).toHaveLength(60);
    });

    it("英数字が 1 つも無い名前は workflow-<id> にし、id の記号は落とす", () => {
      expect(slugForName("運用監視", "AbC123")).toBe("workflow-AbC123");
      expect(slugForName("週次 問い合わせの棚卸し", "a/b-c_d")).toBe("workflow-abcd");
    });

    it("空入力: 名前が空文字・空白だけなら workflow-<id>", () => {
      expect(slugForName("", "wf9")).toBe("workflow-wf9");
      expect(slugForName("   ", "wf9")).toBe("workflow-wf9");
    });
  });
});

describe("assignFileNames", () => {
  const local = (fileName: string, name: string) => ({ fileName, name });

  describe("正常系", () => {
    it("承認済み main のファイルの name と完全一致すれば、そのファイル名を使う", () => {
      const names = assignFileNames(
        [{ id: "a", name: "I-11 Mautic Webhook の受領と重複排除" }],
        [local("I-11-mautic-webhook-dedup.json", "I-11 Mautic Webhook の受領と重複排除")],
      );
      expect(names).toEqual(new Map([["a", "I-11-mautic-webhook-dedup.json"]]));
    });

    it("一致が無ければ名前から作る", () => {
      expect(assignFileNames([{ id: "a", name: "Ops Monitor" }], [])).toEqual(new Map([["a", "ops-monitor.json"]]));
    });

    it("NFD の名前でも NFC の main のファイルに対応づける", () => {
      const nfc = "パイプライン";
      const names = assignFileNames([{ id: "a", name: nfc.normalize("NFD") }], [local("pipeline.json", nfc)]);
      expect(names.get("a")).toBe("pipeline.json");
    });

    it("同じ name の main のファイルが 2 つあれば、ファイル名の順で先のものを使う", () => {
      const names = assignFileNames([{ id: "a", name: "X" }], [local("x-2.json", "X"), local("x-1.json", "X")]);
      expect(names.get("a")).toBe("x-1.json");
    });

    it("入力の順序に依存しない（名前と id の順で決める）", () => {
      const workflows = [
        { id: "b", name: "Same" },
        { id: "a", name: "Same" },
        { id: "c", name: "Other" },
      ];
      const forward = assignFileNames(workflows, []);
      const backward = assignFileNames([...workflows].reverse(), []);
      expect(forward).toEqual(backward);
      expect(forward).toEqual(
        new Map([
          ["c", "other.json"],
          ["a", "same.json"],
          ["b", "same-b.json"],
        ]),
      );
    });

    it("空入力: ワークフローが 0 件なら空の Map", () => {
      expect(assignFileNames([], [local("a.json", "A")])).toEqual(new Map());
      expect(assignFileNames([], [])).toEqual(new Map());
    });
  });

  describe("異常系", () => {
    it("入力: 2 つのワークフローが同じ main のファイルの name に一致したら、id の順で先の 1 つだけがそれを使う", () => {
      const names = assignFileNames(
        [
          { id: "b", name: "I-11 x" },
          { id: "a", name: "I-11 x" },
        ],
        [local("I-11-x.json", "I-11 x")],
      );
      expect(names.get("a")).toBe("I-11-x.json");
      expect(names.get("b")).toBe("I-11-x-b.json");
    });

    it("入力: 新しい名前から作ったファイル名が main の別のファイルと同じなら、横取りせず id を付ける", () => {
      const names = assignFileNames(
        [
          { id: "new1", name: "Ops Monitor" },
          { id: "old1", name: "運用監視（旧）" },
        ],
        [local("ops-monitor.json", "運用監視（旧）")],
      );
      expect(names.get("old1")).toBe("ops-monitor.json");
      expect(names.get("new1")).toBe("ops-monitor-new1.json");
    });

    it("入力: n8n に無いワークフローの main のファイル名も予約として扱い、上書きしない", () => {
      const names = assignFileNames([{ id: "x9", name: "Ops Monitor" }], [local("ops-monitor.json", "削除された旧名")]);
      expect(names.get("x9")).toBe("ops-monitor-x9.json");
    });

    it("入力: id の記号はファイル名に付けるときに落とす", () => {
      const names = assignFileNames(
        [
          { id: "a", name: "Dup" },
          { id: "b/../c", name: "Dup" },
        ],
        [],
      );
      expect(names.get("b/../c")).toBe("dup-bc.json");
      for (const fileName of names.values()) expect(fileName).not.toContain("/");
    });
  });
});

describe("実在の書き出し（W/middleware/n8n/workflows）", () => {
  const root = repositoryRoot();

  describe("正常系", () => {
    it.skipIf(!root)("すべて正規化でき、秘密値の疑いが無く、正規化は冪等で、各ファイルは自分のファイル名に対応づく", () => {
      const dir = join(root!, N8N_WORKFLOWS_DIR);
      const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
      expect(files.length).toBeGreaterThan(0);
      const workflows: { id: string; name: string }[] = [];
      const localFiles: { fileName: string; name: string }[] = [];
      for (const file of files) {
        const normalized = normalizeWorkflow(JSON.parse(readFileSync(join(dir, file), "utf8")));
        expect({ file, suspectedSecret: normalized.suspectedSecret }).toEqual({ file, suspectedSecret: false });
        expect(normalizeWorkflow(JSON.parse(normalized.text)).text).toBe(normalized.text);
        workflows.push({ id: file, name: normalized.name });
        localFiles.push({ fileName: file, name: normalized.name });
      }
      const names = assignFileNames(workflows, localFiles);
      for (const file of files) expect(names.get(file)).toBe(file);
    });
  });
});
