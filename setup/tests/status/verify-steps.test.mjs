// setup/status/verify-steps.mjs（手順の一覧と 00-setup-overview.md のずれの検査）の単体テスト。
// 検査の関数は、一時ディレクトリに置いた小さな Markdown と、テストの中で作ったカタログで確かめる。
// 実際のリポジトリに対しては 1 本だけ、CLI を子プロセスで起動して終了コード 0 を確かめる（読み取りだけ。何も書かない）。
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifySteps } from "../../status/verify-steps.mjs";
import * as realCatalog from "../../status/steps.mjs";
import { makeTempDir, removeTempDir } from "../helpers/temp-home.mjs";

const SETUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(SETUP_DIR, "status/verify-steps.mjs");

// 概要の見本: P1 に 2 行、P2 に 1 行、6 節の表に 2 行
const OVERVIEW = [
  "# 概要",
  "",
  "## 3. 本番",
  "",
  "### P1. 段階 env",
  "",
  "- [ ] **人・端末** AWS CLI を入れる — cloud 2",
  "- [ ] **人・端末** 設定ファイルを書く — cloud 4.1",
  "  - 字下げした補足の行は数えない",
  "- 本文の説明の行（チェック項目ではない）",
  "",
  "### P2. 段階 deploy",
  "",
  "```bash",
  "- [ ] コードブロックの中は数えない",
  "```",
  "- 〔警告〕**人・端末** メールを購読する — cloud 4.10",
  "",
  "## 6. 判断が残っている項目（R1）",
  "",
  "| 項目 | 今の既定 |",
  "|---|---|",
  "| DB をサーバーレスにするか | 既定 |",
  "| CSP をどこで付けるか | 付けていない |",
  "",
  "### DB のコストの比較",
  "",
  "| 構成 | 月額 |",
  "|---|---|",
  "| コストの行 | $1 |",
  "",
].join("\n");

// docs の見本: 2・4.1・4.10 の見出しがあり、コードブロックの中に見出しの形の行がある
const CLOUD_DOC = [
  "# cloud",
  "",
  "## 2. 前提",
  "",
  "### 4.1 global",
  "",
  "### 4.10 マイグレーション",
  "",
  "```bash",
  "# 2. これはコメントで見出しではない",
  "```",
  "",
  "### 4.5 IAM",
  "",
  "#### 4.5.1 配信用",
  "",
].join("\n");

function item(id, overviewText, extra = {}) {
  return { id, title: id, who: "人・端末", kind: "検査", overviewText, probe: { kind: "module", module: "cloud", phase: "env" }, docs: [], ...extra };
}

function makeCatalog(overrides = {}) {
  return {
    CATALOG_VERSION: 1,
    PRODUCT_API_MODULES: [],
    KNOWN_ITEM_KEYS: [{ key: "cloud.sns", steps: ["P2"] }],
    STEPS: [
      { id: "P1", title: "env", items: [
        item("P1.aws", "AWS CLI を入れる", { docs: [{ file: "cloud/README.md", heading: "2" }] }),
        item("P1.conf", "設定ファイルを書く", { docs: [{ file: "cloud/README.md", heading: "4.1" }] }),
      ] },
      { id: "P2", title: "deploy", items: [
        item("P2.sns", "メールを購読する", { kind: "警告", probe: { kind: "item", key: "cloud.sns" }, docs: [{ file: "cloud/README.md", heading: "4.10" }] }),
      ] },
      { id: "R1", title: "判断", items: [
        item("R1.db", "DB をサーバーレスにするか", { who: "判断", kind: "判断", probe: { kind: "none" } }),
        item("R1.csp", "CSP をどこで付けるか", { who: "判断", kind: "判断", probe: { kind: "none" } }),
      ] },
    ],
    ...overrides,
  };
}

let root;

beforeEach(() => {
  root = makeTempDir("comegin-verify-steps-");
  mkdirSync(join(root, "setup"), { recursive: true });
  mkdirSync(join(root, "cloud"), { recursive: true });
  writeFileSync(join(root, "setup/00-setup-overview.md"), OVERVIEW);
  writeFileSync(join(root, "cloud/README.md"), CLOUD_DOC);
});

afterEach(() => {
  removeTempDir(root);
});

/** 見本の概要の一部を書き換える */
function writeOverview(replacer) {
  writeFileSync(join(root, "setup/00-setup-overview.md"), replacer(OVERVIEW));
}

function stepsWith(id, mutate) {
  const c = makeCatalog();
  const step = c.STEPS.find((s) => s.id === id);
  mutate(step);
  return c;
}

describe("正常系", () => {
  it("入力: 概要とカタログが一致していれば、ずれは 0 件", () => {
    const { problems, itemCount } = verifySteps({ root, catalog: makeCatalog() });
    expect(problems).toEqual([]);
    expect(itemCount).toBe(5);
  });

  it("入力: 末尾が数字の heading は、後ろに数字が続く見出しに当たらない（2 は 2. だけ。4.1 は 4.10 に当たらない。4.5 は 4.5.1 に当たらない）", () => {
    const c = makeCatalog();
    c.STEPS[0].items[0].docs = [
      { file: "cloud/README.md", heading: "2" },
      { file: "cloud/README.md", heading: "4.1" },
      { file: "cloud/README.md", heading: "4.5" },
      { file: "cloud/README.md", heading: "4.5.1" },
    ];
    expect(verifySteps({ root, catalog: c }).problems).toEqual([]);
  });

  it("入力: コードブロックの中の # の行は見出しに数えない", () => {
    const c = makeCatalog();
    c.STEPS[0].items[0].docs = [{ file: "cloud/README.md", heading: "2. これはコメント" }];
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("で始まる見出しが無い");
  });

  it("入力: 同じ key を 2 つの段階に出すと KNOWN_ITEM_KEYS に両方の段階があれば通る", () => {
    writeOverview((t) => t.replace("- [ ] **人・端末** 設定ファイルを書く — cloud 4.1", "- [ ] **人・端末** 設定ファイルを書く — cloud 4.1\n- 〔警告〕本文の 2 つめ"));
    const c = makeCatalog({ KNOWN_ITEM_KEYS: [{ key: "cloud.sns", steps: ["P1", "P2"] }] });
    c.STEPS[0].items.push(item("P1.sns", "本文の 2 つめ", { kind: "警告", probe: { kind: "item", key: "cloud.sns" } }));
    expect(verifySteps({ root, catalog: c }).problems).toEqual([]);
  });

  it("入力: どの項目の probe にもなっていない (key, 段階) は注意として返すが、失敗にはしない", () => {
    const c = makeCatalog({ KNOWN_ITEM_KEYS: [{ key: "cloud.sns", steps: ["P2"] }, { key: "cloud.other", steps: ["P1"] }] });
    const { problems, notes } = verifySteps({ root, catalog: c });
    expect(problems).toEqual([]);
    expect(notes.filter((n) => n.startsWith("注意: モジュールが出す"))).toEqual(["注意: モジュールが出す cloud.other（P1）は、カタログのどの項目の probe にもなっていない"]);
  });

  it("入力: items の probe は、keys の 1 つ 1 つが KNOWN_ITEM_KEYS の (key, 段階) にあれば通り、どれも使われたものとして数える", () => {
    const c = makeCatalog({ KNOWN_ITEM_KEYS: [{ key: "cloud.sns", steps: ["P2"] }, { key: "cloud.sns2", steps: ["P2"] }] });
    c.STEPS[1].items[0].probe = { kind: "items", keys: ["cloud.sns", "cloud.sns2"] };
    const { problems, notes } = verifySteps({ root, catalog: c });
    expect(problems).toEqual([]);
    expect(notes.filter((n) => n.startsWith("注意: モジュールが出す"))).toEqual([]);
  });

  it("入力: 字下げのない `- ` の行でチェック項目の形ではないものは、数えずに注意として返す（失敗にはしない）", () => {
    const { problems, notes } = verifySteps({ root, catalog: makeCatalog() });
    expect(problems).toEqual([]);
    expect(notes.some((n) => n.startsWith("注意: P1 に、チェック項目の形") && n.includes("本文の説明の行"))).toBe(true);
    // 字下げした補足とコードブロックの中は注意にも出ない
    expect(notes.some((n) => n.includes("字下げした補足") || n.includes("コードブロックの中"))).toBe(false);
  });

  it("入力: 実際のカタログの drift は、site-redeploy が P12 の 2 項目だけ・n8n-workflows が P14 の 1 項目だけ", () => {
    const drifts = [];
    for (const step of realCatalog.STEPS) {
      for (const it of step.items) if (it.probe.kind === "drift") drifts.push(`${it.probe.id}:${step.id}:${it.id}`);
    }
    expect(drifts.sort()).toEqual(["n8n-workflows:P14:P14.n8n-schedule", "site-redeploy:P12:P12.build", "site-redeploy:P12:P12.rebuild"]);
  });

  it("入力: 実際のカタログの KNOWN_ITEM_KEYS は key が重複していない（複数の段階は steps に並べる）", () => {
    const keys = realCatalog.KNOWN_ITEM_KEYS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("入力: 実際のリポジトリの概要とカタログは一致していて、CLI は終了コード 0", () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(r.stderr.split("\n").filter((l) => !l.startsWith("注意:"))).toEqual([""]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OK:");
  });
});

describe("異常系", () => {
  it("入力: 項目の数が合わない（概要は 2 行・カタログは 1 件）と、数と対応のない行を返す", () => {
    const c = stepsWith("P1", (s) => s.items.pop());
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems).toContain("P1: 項目の数が合わない（setup/00-setup-overview.md は 2 行・STEPS は 1 件）");
    expect(problems.some((p) => p.startsWith("P1: 対応する項目が無い行:") && p.includes("設定ファイルを書く"))).toBe(true);
  });

  it("入力: overviewText が節に無いと、段階と項目の id と文字列を返す", () => {
    const c = stepsWith("P1", (s) => { s.items[1].overviewText = "存在しない文字列"; });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems.some((p) => p.startsWith("P1 P1.conf: overviewText") && p.includes("P1 の節に無い") && p.includes("存在しない文字列"))).toBe(true);
  });

  it("入力: overviewText が節に 2 回現れると、1 回だけにするよう返す", () => {
    writeOverview((t) => t.replace("- 本文の説明の行（チェック項目ではない）", "- 本文の説明の行（AWS CLI を入れる）"));
    const { problems } = verifySteps({ root, catalog: makeCatalog() });
    expect(problems.some((p) => p.startsWith("P1 P1.aws:") && p.includes("2 回現れる"))).toBe(true);
  });

  it("入力: overviewText がチェック項目の行ではなく本文の行にだけあると返す", () => {
    const c = stepsWith("P1", (s) => { s.items[1].overviewText = "チェック項目ではない"; });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems.some((p) => p.startsWith("P1 P1.conf:") && p.includes("チェック項目の行") && p.includes("中に無い"))).toBe(true);
  });

  it("入力: コードブロックの中の行の overviewText は節に無いものとして扱う", () => {
    const c = stepsWith("P2", (s) => { s.items[0].overviewText = "コードブロックの中は数えない"; });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems.some((p) => p.startsWith("P2 P2.sns: overviewText") && p.includes("P2 の節に無い"))).toBe(true);
  });

  it("入力: 2 つの項目が同じ行を指すと返す", () => {
    const c = stepsWith("P1", (s) => { s.items[1].overviewText = "AWS CLI を入れる"; });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems.some((p) => p.startsWith("P1 P1.conf: P1.aws と同じ行を指している"))).toBe(true);
    expect(problems.some((p) => p.startsWith("P1: 対応する項目が無い行:"))).toBe(true);
  });

  it("入力: 項目の順番が概要の行の順と違うと返す", () => {
    const c = stepsWith("P1", (s) => s.items.reverse());
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems.some((p) => p.includes("P1.aws") && p.includes("順番"))).toBe(true);
  });

  it("入力: 6 節の表の行（R1）の数が合わないと返す", () => {
    const c = stepsWith("R1", (s) => s.items.pop());
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems).toContain("R1: 項目の数が合わない（setup/00-setup-overview.md は 2 行・STEPS は 1 件）");
  });

  it("入力: docs の見出しが無いと、ファイルと heading を返す", () => {
    const c = stepsWith("P1", (s) => { s.items[0].docs = [{ file: "cloud/README.md", heading: "9.9" }]; });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems).toContain('P1 P1.aws: cloud/README.md に "9.9" で始まる見出しが無い');
  });

  it("入力: docs の見出しが 2 つ当たると、曖昧として返す", () => {
    writeFileSync(join(root, "cloud/README.md"), `${CLOUD_DOC}\n### 常駐させる（A）\n\n### 常駐させる（B）\n`);
    const c = stepsWith("P1", (s) => { s.items[0].docs = [{ file: "cloud/README.md", heading: "常駐させる" }]; });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems.some((p) => p.startsWith("P1 P1.aws:") && p.includes("見出しが 2 個ある"))).toBe(true);
  });

  it("入力: docs のファイルが無いと返す", () => {
    const c = stepsWith("P1", (s) => { s.items[0].docs = [{ file: "onprem/README.md", heading: "1" }]; });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems).toContain("P1 P1.aws: docs のファイル onprem/README.md が無い");
  });

  it("入力: KNOWN_ITEM_KEYS に無い key を probe にすると返す", () => {
    const c = stepsWith("P2", (s) => { s.items[0].probe = { kind: "item", key: "cloud.nothing" }; });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems).toContain('P2 P2.sns: probe の key "cloud.nothing" が KNOWN_ITEM_KEYS に無い');
  });

  it("入力: key はあるが、その段階には出さない key だと返す（同じ key でも段階まで見る）", () => {
    const c = makeCatalog({ KNOWN_ITEM_KEYS: [{ key: "cloud.sns", steps: ["P12"] }] });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems.some((p) => p.startsWith("P2 P2.sns:") && p.includes("P12 に出す項目") && p.includes("P2 には出ない"))).toBe(true);
  });

  it("入力: items の probe の中に KNOWN_ITEM_KEYS に無い key があると、その key を返す", () => {
    const c = makeCatalog();
    c.STEPS[1].items[0].probe = { kind: "items", keys: ["cloud.sns", "cloud.nothing"] };
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems).toEqual(['P2 P2.sns: probe の key "cloud.nothing" が KNOWN_ITEM_KEYS に無い']);
  });

  it("入力: items の probe の中に、その段階には出さない key があると返す", () => {
    const c = makeCatalog({ KNOWN_ITEM_KEYS: [{ key: "cloud.sns", steps: ["P2"] }, { key: "cloud.other", steps: ["P12"] }] });
    c.STEPS[1].items[0].probe = { kind: "items", keys: ["cloud.sns", "cloud.other"] };
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems.some((p) => p.startsWith("P2 P2.sns: key \"cloud.other\" は P12 に出す項目で、P2 には出ない"))).toBe(true);
  });

  it("空入力: items の probe の keys が空配列・無い・空文字を含むと返す", () => {
    for (const probe of [{ kind: "items", keys: [] }, { kind: "items" }, { kind: "items", keys: ["cloud.sns", ""] }]) {
      const c = makeCatalog();
      c.STEPS[1].items[0].probe = probe;
      const { problems } = verifySteps({ root, catalog: c });
      expect(problems).toContain("P2 P2.sns: probe の keys が空、または文字列ではない");
    }
  });

  it("入力: 概要に同じ `### P<n>.` の見出しが 2 つあると、黙って上書きせずに返す", () => {
    writeOverview((t) => `${t}\n### P1. もう一度\n\n- [ ] **人・端末** 別の項目\n`);
    const { problems } = verifySteps({ root, catalog: makeCatalog() });
    expect(problems).toContain("P1: setup/00-setup-overview.md に `### P1.` の見出しが 2 つ以上ある");
  });

  it("入力: 概要にある P の見出しが STEPS に無いと返す", () => {
    const c = makeCatalog();
    c.STEPS = c.STEPS.filter((s) => s.id !== "P2");
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems).toContain("P2: setup/00-setup-overview.md にあるが、STEPS に無い");
  });

  it("入力: STEPS の段階が概要に見出しを持たないと返す", () => {
    const c = makeCatalog();
    c.STEPS.push({ id: "P3", title: "images", items: [] });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems).toContain("P3: STEPS にあるが、setup/00-setup-overview.md に見出し（`### P3.`）が無い");
  });

  it("入力: 段階の中で id が重複している・who と kind が不正・none なのに検査、を返す", () => {
    const c = stepsWith("P1", (s) => {
      s.items[1].id = "P1.aws";
      s.items[0].who = "だれか";
      s.items[0].kind = "なにか";
      s.items[1].probe = { kind: "none" };
    });
    const { problems } = verifySteps({ root, catalog: c });
    expect(problems.some((p) => p.includes("id が重複"))).toBe(true);
    expect(problems.some((p) => p.includes("who が不正"))).toBe(true);
    expect(problems.some((p) => p.includes("kind が不正"))).toBe(true);
    expect(problems.some((p) => p.includes("kind が 検査 なのに probe が none"))).toBe(true);
  });

  it("空入力: 概要のファイルが root に無いと、ずれ 1 件として返す", () => {
    const empty = makeTempDir("comegin-verify-steps-empty-");
    try {
      const { problems } = verifySteps({ root: empty, catalog: makeCatalog() });
      expect(problems).toEqual([`setup/00-setup-overview.md が ${empty} に無い`]);
    } finally {
      removeTempDir(empty);
    }
  });
});

describe("異常系（CLI）", () => {
  it("入力: --root に概要の無いディレクトリを渡すと、終了コード 1 で理由を標準エラーに出す", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", root + "-none"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("00-setup-overview.md が");
    expect(r.stderr).toContain("NG:");
  });

  it("入力: --root の値が無い・知らない引数は、検査せずに終了コード 1", () => {
    expect(spawnSync(process.execPath, [SCRIPT, "--root"], { encoding: "utf8" }).status).toBe(1);
    expect(spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" }).status).toBe(1);
  });

});
