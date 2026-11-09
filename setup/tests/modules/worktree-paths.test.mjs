// コードを承認済みの main のチェックアウトから動かすとき（監視アプリが子プロセスで --check する。REPO がチェックアウトを指し、
// WORKTREE が人の作業ツリーを指す）に、next-js-prod・verdant-virgo・onprem が WORKTREE を基点に動くことの単体テスト。
// AWS・git・systemd・HTTP は偽物に差し替える。ファイルは一時ディレクトリだけに置く。
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, itemsByKey } from "../helpers/fake-ctx.mjs";
import { makeTempDir, removeTempDir } from "../helpers/temp-home.mjs";

const mocks = vi.hoisted(() => ({ awsResponses: {} }));
vi.mock("../../../cloud/setup/aws.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  awsJson: async (_ctx, args) => {
    const r = mocks.awsResponses[`${args[0]} ${args[1]}`];
    if (r instanceof Error) throw r;
    return r === undefined ? null : r;
  },
}));

const nextJs = await import("../../../frontend/next-js/setup/prod/index.mjs");
const site = await import("../../../frontend/verdant-virgo/setup/index.mjs");
const onprem = await import("../../../onprem/setup/index.mjs");

let checkout; // 承認済みの main のチェックアウト
let worktree; // 人の作業ツリー
let other;

beforeEach(() => {
  mocks.awsResponses = {};
  checkout = makeTempDir("comegin-checkout-");
  worktree = makeTempDir("comegin-worktree-");
  other = makeTempDir("comegin-other-");
  mkdirSync(join(checkout, "frontend/next-js"), { recursive: true });
  writeFileSync(join(checkout, "frontend/next-js/package.json"), "{}\n");
  mkdirSync(join(checkout, "frontend/verdant-virgo"), { recursive: true });
});
afterEach(() => {
  for (const d of [checkout, worktree, other]) removeTempDir(d);
});

/** git の呼び出しを記録する偽の run。HEAD は head、origin/main は origin を返す。systemctl などは失敗する */
function gitRun({ head, origin }) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args.includes("rev-parse") && args.includes("HEAD")) return `${head}\n`;
    if (cmd === "git" && args.includes("rev-parse") && args.includes("origin/main")) return `${origin}\n`;
    if (cmd === "git" && args.includes("log")) return "1700000000\n";
    if (cmd === "aws" && args[0] === "sts") return JSON.stringify({ Arn: "arn:aws:iam::111:user/comegin-prod-control-plane" });
    throw new Error(`${cmd} が使えない（偽）`);
  };
  return { run, calls };
}

const nextCtx = ({ repo, wt, run }) =>
  fakeCtx({
    conf: { CONTROL_MAIN_CHECKOUT: checkout, CONTROL_AWS_CREDENTIALS_FILE: join(other, "no-credentials") },
    overrides: { phase: "operate", REPO: repo, WORKTREE: wt, W: repo, run },
  });

describe("next-js-prod の check", () => {
  describe("正常系", () => {
    it("入力: 比べる相手は WORKTREE。REPO がチェックアウト自身でも「作業ツリーと同じ場所」で止まらず、origin/main は WORKTREE から読む", async () => {
      const { run, calls } = gitRun({ head: "a".repeat(40), origin: "a".repeat(40) });
      const r = await nextJs.check(nextCtx({ repo: checkout, wt: worktree, run }));
      expect(r.notes[0]).toContain("は origin/main と同じ");
      expect(calls).toContainEqual(["git", "-C", worktree, "rev-parse", "origin/main"]);
      expect(calls).toContainEqual(["git", "-C", checkout, "rev-parse", "HEAD"]);
      expect(itemsByKey(r)["next-js-prod.checkout"].level).toBe("ok");
    });

    it("入力: 16 個の key をすべて P14 で返し、問題のある項目には今止まる id が付く", async () => {
      const { run } = gitRun({ head: "a".repeat(40), origin: "a".repeat(40) });
      const r = await nextJs.check(nextCtx({ repo: checkout, wt: worktree, run }));
      const by = itemsByKey(r);
      expect(r.items.map((i) => i.key)).toEqual(["checkout", "build", "principal", "status-principal", "status-github", "agent-worktree", "cycle", "strapi-tokens", "deploy-values", "openai", "mautic-reader", "prod-values", "systemd", "respond", "heartbeat-alarm", "schedules-enabled"].map((n) => `next-js-prod.${n}`));
      expect(r.items.every((i) => i.step === "P14")).toBe(true);
      expect(by["next-js-prod.build"]).toMatchObject({ level: "action", stopId: "next-js-prod:build" });
      expect(by["next-js-prod.principal"]).toMatchObject({ level: "action", stopId: "next-js-prod:principal" });
      expect(by["next-js-prod.prod-values"]).toMatchObject({ level: "action", stopId: "next-js-prod:prod-values" });
      expect(by["next-js-prod.systemd"]).toMatchObject({ level: "action", stopId: "next-js-prod:systemd" });
      expect(by["next-js-prod.respond"]).toMatchObject({ level: "action", stopId: "next-js-prod:start" });
      expect(by["next-js-prod.heartbeat-alarm"].level).toBe("warn"); // アラームが無い
      expect(by["next-js-prod.schedules-enabled"].level).toBe("warn"); // 有効な定期実行が 0 本
      expect(r.ok).toBe(false);
    });

    it("入力: IAM を読めないだけなら principal は unknown（action にしない）", async () => {
      mocks.awsResponses["iam get-user"] = new Error("AccessDenied");
      const credentials = join(other, "aws-credentials"); // 資格情報ファイル側は問題が無い状態にする
      writeFileSync(credentials, "[comegin-prod-control-plane]\naws_access_key_id = x\n");
      chmodSync(credentials, 0o600);
      const { run } = gitRun({ head: "a".repeat(40), origin: "a".repeat(40) });
      const ctx = nextCtx({ repo: checkout, wt: worktree, run });
      ctx.conf.CONTROL_AWS_CREDENTIALS_FILE = credentials;
      const r = await nextJs.check(ctx);
      expect(itemsByKey(r)["next-js-prod.principal"].level).toBe("unknown");
    });
  });

  describe("異常系", () => {
    it("入力: チェックアウトが WORKTREE と同じ場所なら「作業ツリーと同じ場所」で止まり、checkout が action、ほかは unknown", async () => {
      const { run } = gitRun({ head: "a".repeat(40), origin: "a".repeat(40) });
      const r = await nextJs.check(nextCtx({ repo: other, wt: checkout, run }));
      expect(r.ok).toBe(false);
      expect(r.notes).toEqual([expect.stringContaining("作業ツリーと同じ場所")]);
      const by = itemsByKey(r);
      expect(by["next-js-prod.checkout"]).toMatchObject({ level: "action", stopId: "next-js-prod:checkout" });
      expect(r.items.filter((i) => i.level === "unknown")).toHaveLength(15);
    });

    it("サーバ: チェックアウトの HEAD が WORKTREE の origin/main と違うと checkout が action（コミットの先頭 8 文字だけが出る）", async () => {
      const { run } = gitRun({ head: "a".repeat(40), origin: "b".repeat(40) });
      const r = await nextJs.check(nextCtx({ repo: checkout, wt: worktree, run }));
      const i = itemsByKey(r)["next-js-prod.checkout"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("bbbbbbbb");
      expect(i.evidence).not.toContain("b".repeat(40));
    });

    it("入力: CONTROL_WORKTREE を prod.conf に書いていれば、それと比べる（REPO・WORKTREE ではなく）", async () => {
      const { run } = gitRun({ head: "a".repeat(40), origin: "a".repeat(40) });
      const ctx = nextCtx({ repo: other, wt: worktree, run });
      ctx.conf.CONTROL_WORKTREE = checkout;
      const r = await nextJs.check(ctx);
      expect(r.notes[0]).toContain("作業ツリーと同じ場所");
    });
  });
});

describe("verdant-virgo の check（prod）", () => {
  const siteCtx = ({ repo, wt }) =>
    fakeCtx({ conf: { SITE_BUILD_CHECKOUT: checkout }, overrides: { phase: "apps", REPO: repo, W: repo, WORKTREE: wt } });

  describe("正常系", () => {
    it("入力: REPO がチェックアウト自身でも、WORKTREE が別なら止まらず、チェックアウトの環境変数ファイルを見に行く", async () => {
      const r = await site.check(siteCtx({ repo: checkout, wt: worktree }));
      expect(r.ok).toBe(false);
      expect(r.notes.some((n) => n.includes(join(checkout, "frontend/verdant-virgo", ".env.production")) && n.includes("まだ無い"))).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: SITE_BUILD_CHECKOUT が WORKTREE と同じ場所なら「作業ツリーと同じ場所」で止まる", async () => {
      await expect(site.check(siteCtx({ repo: other, wt: checkout }))).rejects.toThrow("作業ツリーと同じ場所");
    });
  });
});

describe("onprem の check", () => {
  const onpremCtx = ({ w, wt }) => fakeCtx({ overrides: { phase: "apps", W: w, REPO: w, WORKTREE: wt } });

  describe("正常系", () => {
    it("入力: onprem/<名前>/.env の有無は WORKTREE から見る（コードの置き場 W にあるかは見ない）", async () => {
      mkdirSync(join(worktree, "onprem/strapi"), { recursive: true });
      writeFileSync(join(worktree, "onprem/strapi/.env"), "X=1\n");
      const r = await onprem.check(onpremCtx({ w: other, wt: worktree }));
      expect(r.notes).toContain("onprem/strapi の環境変数ファイル: ある");
      expect(r.notes).toContain("onprem/n8n の環境変数ファイル: まだ無い");
    });
  });

  describe("異常系", () => {
    it("入力: コードの置き場（W）に .env があっても、WORKTREE に無ければ「まだ無い」", async () => {
      mkdirSync(join(other, "onprem/n8n"), { recursive: true });
      writeFileSync(join(other, "onprem/n8n/.env"), "X=1\n");
      const r = await onprem.check(onpremCtx({ w: other, wt: worktree }));
      expect(r.notes).toContain("onprem/n8n の環境変数ファイル: まだ無い");
      expect(r.ok).toBe(false);
    });
  });
});
