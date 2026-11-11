// onprem/setup/index.mjs の check が返す items（onprem.strapi-image・onprem.n8n-image・onprem.n8n-version）の単体テスト。
// docker と git は偽物に差し替える（ctx.run）。実際の Docker・git・本番のサービスには触れない。
// n8n の環境変数ファイルは一時ディレクトリに偽のものを作り、ctx.WORKTREE をそこに向ける（実際のファイルは読まない）。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeCtx, itemsByKey } from "../helpers/fake-ctx.mjs";
import { makeTempDir, removeTempDir } from "../helpers/temp-home.mjs";

const { check } = await import("../../../onprem/setup/index.mjs");

const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);
const STRAPI_IMAGE_ID = "sha256:" + "1".repeat(64);
const N8N_IMAGE_ID = "sha256:" + "2".repeat(64);
const OLD_IMAGE_ID = "sha256:" + "9".repeat(64);
const N8N_DIGEST = "sha256:" + "c".repeat(64);
const RUNNERS_DIGEST = "sha256:" + "d".repeat(64);
const DB_PASSWORD = "pw-secret-value-0123456789";
const STRAPI_KEYS = ["onprem.strapi-image", "onprem.n8n-image", "onprem.n8n-version"];

let worktree;
beforeEach(() => {
  worktree = makeTempDir("comegin-onprem-items-");
});
afterEach(() => removeTempDir(worktree));

const envFileText = (v = {}) =>
  [
    "# 本番の n8n（テスト用の偽のファイル）",
    `N8N_VERSION=${v.version ?? "2.39.5"}`,
    `N8N_DIGEST=${v.digest ?? N8N_DIGEST}`,
    `N8N_RUNNERS_DIGEST=${v.runners ?? RUNNERS_DIGEST}`,
    `DB_POSTGRESDB_PASSWORD=${DB_PASSWORD}`,
    "N8N_ENCRYPTION_KEY=enc-key-secret-9876543210",
    "",
  ].join("\n");

function writeN8nEnv(v) {
  mkdirSync(join(worktree, "onprem/n8n"), { recursive: true });
  writeFileSync(join(worktree, "onprem/n8n", ".env"), envFileText(v));
}

/** docker・git の応答。scene を書き換えて、場面を作る */
function newScene() {
  return {
    docker: true,
    // イメージ（docker image inspect）。値が Error なら投げる
    images: {
      "comegin/strapi-onprem:local": { id: STRAPI_IMAGE_ID, labels: { "org.opencontainers.image.revision": SHA_NEW } },
      "comegin/n8n-onprem:2.39.5": {
        id: N8N_IMAGE_ID,
        labels: { "org.opencontainers.image.revision": SHA_NEW, "com.comegin.n8n-version": "2.39.5", "com.comegin.n8n-digest": N8N_DIGEST },
      },
    },
    // 動いているコンテナ（compose のプロジェクトとサービス → コンテナ ID の配列）
    containers: { "comegin-prod-strapi/strapi": ["cs1"], "comegin-prod-n8n/n8n": ["cn1"], "comegin-prod-n8n/runners": ["cr1"] },
    containerImage: { cs1: STRAPI_IMAGE_ID, cn1: N8N_IMAGE_ID },
    containerLabels: {
      cn1: { "com.comegin.n8n-version": "2.39.5", "com.comegin.n8n-digest": N8N_DIGEST },
    },
    containerConfigImage: { cr1: `ghcr.io/n8n-io/runners:2.39.5@${RUNNERS_DIGEST}` },
    dockerError: null, // docker のすべての呼び出しが投げるエラー
    psError: null, // docker ps だけが投げるエラー（イメージの inspect は通る）
    // git
    inMain: { [SHA_NEW]: true, [SHA_OLD]: true },
    log: "", // git log の出力
    logError: null,
    example: envFileText(), // git show origin/main:onprem/n8n/<例のファイル> の出力。Error なら投げる
  };
}

function makeRun(scene, calls) {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "docker") {
      if (scene.dockerError) throw scene.dockerError;
      const fmt = args[args.indexOf("--format") + 1];
      if (args[0] === "image" && args[1] === "inspect") {
        const img = scene.images[args[args.length - 1]];
        if (!img) throw new Error("docker image inspect が失敗した（終了コード 1）\nError response from daemon: No such image: x");
        return `${img.id}\t${JSON.stringify(img.labels ?? null)}\n`;
      }
      if (args[0] === "ps") {
        if (scene.psError) throw scene.psError;
        const project = args.find((a) => a.startsWith("label=com.docker.compose.project=")).split("=").slice(2).join("=");
        const service = args.find((a) => a.startsWith("label=com.docker.compose.service=")).split("=").slice(2).join("=");
        return (scene.containers[`${project}/${service}`] ?? []).join("\n") + "\n";
      }
      if (args[0] === "inspect") {
        const id = args[args.length - 1];
        if (fmt === "{{.Image}}") return `${scene.containerImage[id]}\n`;
        if (fmt === "{{json .Config.Labels}}") return `${JSON.stringify(scene.containerLabels[id] ?? null)}\n`;
        if (fmt === "{{.Config.Image}}") return `${scene.containerConfigImage[id]}\n`;
      }
      throw new Error(`想定していない docker の呼び出し: ${args.join(" ")}`);
    }
    if (cmd === "git") {
      const sub = args[2];
      if (sub === "merge-base") {
        if (scene.inMain[args[4]]) return "";
        throw Object.assign(new Error("git merge-base が失敗した（終了コード 1）"), { exitCode: 1 });
      }
      if (sub === "log") {
        if (scene.logError) throw scene.logError;
        return typeof scene.log === "function" ? scene.log(args) : scene.log;
      }
      if (sub === "show") {
        if (scene.example instanceof Error) throw scene.example;
        return scene.example;
      }
    }
    // ip・systemctl・ss は、このテストでは見ない（commandExists が false）
    throw new Error(`想定していない呼び出し: ${cmd} ${args.join(" ")}`);
  };
}

function ctxFor(scene, calls = []) {
  return fakeCtx({
    overrides: {
      phase: "apps",
      WORKTREE: worktree,
      run: makeRun(scene, calls),
      commandExists: async (c) => c === "docker" && scene.docker,
    },
  });
}

const run = async (scene, calls) => itemsByKey(await check(ctxFor(scene, calls)));
const logLine = (sha, subject) => `${sha}\t2026-11-10T12:00:00+09:00\t${subject}\n`;

describe("onprem の items", () => {
  describe("正常系", () => {
    it("入力: すべて追いついていると 3 つの key が level ok で返り、step は P6", async () => {
      writeN8nEnv();
      const r = await check(ctxFor(newScene()));
      expect(r.items.map((i) => i.key)).toEqual(STRAPI_KEYS);
      for (const i of r.items) {
        expect(i.level, i.key).toBe("ok");
        expect(i.step).toBe("P6");
        expect(i.title.length).toBeGreaterThan(0);
        expect(i.evidence.length).toBeGreaterThan(0);
      }
    });

    it("入力: 雛形（.env.example）と .env が同じ 3 つの値だと onprem.n8n-version は ok", async () => {
      writeN8nEnv();
      expect((await run(newScene()))["onprem.n8n-version"].level).toBe("ok");
    });

    it("入力: 既存の ok・notes は items を足しても今までどおり（docker の有無で変わらない）", async () => {
      const noDocker = newScene();
      noDocker.docker = false;
      const a = await check(ctxFor(noDocker));
      const b = await check(ctxFor(newScene()));
      expect(b.ok).toBe(a.ok);
      expect(b.notes).toEqual(a.notes);
      expect(a.ok).toBe(false);
    });
  });

  describe("異常系: onprem.strapi-image", () => {
    it("入力: ラベルの revision が空だと action で「記録が無い」と node onprem/build.mjs strapi", async () => {
      const s = newScene();
      s.images["comegin/strapi-onprem:local"].labels = { "org.opencontainers.image.revision": "" };
      writeN8nEnv();
      const i = (await run(s))["onprem.strapi-image"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("記録が無い");
      expect(i.evidence).toContain("node onprem/build.mjs strapi");
    });

    it("入力: ラベルが 40 桁の 16 進数でないと、git を呼ばずに記録が無いとして action", async () => {
      const s = newScene();
      s.images["comegin/strapi-onprem:local"].labels = { "org.opencontainers.image.revision": "not-a-commit; rm -rf /" };
      writeN8nEnv();
      const calls = [];
      const i = (await run(s, calls))["onprem.strapi-image"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("記録が無い");
      expect(calls.some((c) => c[0] === "git" && c.includes("not-a-commit; rm -rf /"))).toBe(false);
    });

    it("入力: ラベルが無い（古いビルド）と action", async () => {
      const s = newScene();
      s.images["comegin/strapi-onprem:local"].labels = null;
      writeN8nEnv();
      expect((await run(s))["onprem.strapi-image"].level).toBe("action");
    });

    it("入力: 記録の後に backend/strapi-system/src を変えたコミットがあると action で、パスと件数が根拠に出る", async () => {
      const s = newScene();
      s.images["comegin/strapi-onprem:local"].labels = { "org.opencontainers.image.revision": SHA_OLD };
      s.log = logLine(SHA_NEW, "mod: strapi の許可するメディアの種類");
      writeN8nEnv();
      const calls = [];
      const i = (await run(s, calls))["onprem.strapi-image"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("1 件");
      expect(i.evidence).toContain("bbbbbbb");
      expect(i.evidence).toContain("node onprem/build.mjs strapi");
      const log = calls.find((c) => c[0] === "git" && c[3] === "log" && c.includes(`${SHA_OLD}..origin/main`));
      expect(log).toBeDefined();
      expect(log).toContain("backend/strapi-system");
      expect(log).toContain("onprem/strapi");
      expect(log).not.toContain("onprem/n8n/Dockerfile");
    });

    it("入力: log の引数に .dockerignore が外すもの（.claude・data・.gitignore・public/uploads）の除外が入り、Dockerfile と雛形は除かれない", async () => {
      const s = newScene();
      s.images["comegin/strapi-onprem:local"].labels = { "org.opencontainers.image.revision": SHA_OLD };
      writeN8nEnv();
      const calls = [];
      await run(s, calls);
      const log = calls.find((c) => c[0] === "git" && c[3] === "log" && c.includes("backend/strapi-system"));
      for (const p of ["backend/strapi-system/.claude", "backend/strapi-system/data", "backend/strapi-system/.gitignore"]) {
        expect(log, p).toContain(`:(exclude)${p}`);
      }
      expect(log).toContain(":(exclude,glob)backend/strapi-system/public/uploads/*");
      // ビルドに効くもの（Dockerfile・.dockerignore・環境変数の雛形）は除外に入れない
      expect(log.filter((a) => a.startsWith(":(exclude")).some((a) => /Dockerfile|\.dockerignore|\.env/.test(a))).toBe(false);
      // 共通の除外（*.md・テスト類）も付く
      expect(log).toContain(":(exclude,glob)**/*.md");
    });

    it("サーバ: ビルドし直しが要る変更を見つけた後に docker ps が失敗しても、action は落とさず、確かめられなかったことを足す", async () => {
      const s = newScene();
      s.images["comegin/strapi-onprem:local"].labels = { "org.opencontainers.image.revision": SHA_OLD };
      s.log = logLine(SHA_NEW, "fix: x");
      s.psError = new Error("docker ps が失敗した（終了コード 1）");
      writeN8nEnv();
      const i = (await run(s))["onprem.strapi-image"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("1 件");
      expect(i.evidence).toContain("docker で確かめられない");
    });

    it("入力: 記録のコミットが origin/main の履歴に無いと warn", async () => {
      const s = newScene();
      s.images["comegin/strapi-onprem:local"].labels = { "org.opencontainers.image.revision": "e".repeat(40) };
      writeN8nEnv();
      const i = (await run(s))["onprem.strapi-image"];
      expect(i.level).toBe("warn");
      expect(i.evidence).toContain("eeeeeee");
    });

    it("入力: イメージは新しいがコンテナのイメージ ID が違うと action で「再起動していない」", async () => {
      const s = newScene();
      s.containerImage.cs1 = OLD_IMAGE_ID;
      writeN8nEnv();
      const i = (await run(s))["onprem.strapi-image"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("再起動していない");
      expect(i.evidence).toContain("sudo systemctl restart comegin-strapi");
    });

    it("入力: 変更もあり再起動もしていないときは、両方の理由が根拠に出る", async () => {
      const s = newScene();
      s.images["comegin/strapi-onprem:local"].labels = { "org.opencontainers.image.revision": SHA_OLD };
      s.log = logLine(SHA_NEW, "fix: x");
      s.containerImage.cs1 = OLD_IMAGE_ID;
      writeN8nEnv();
      const i = (await run(s))["onprem.strapi-image"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("1 件");
      expect(i.evidence).toContain("再起動していない");
    });

    it("入力: コンテナが動いていないと、イメージが最新でも unknown（再起動の要否を確かめられない。止まっていることは apps の判定が出す）", async () => {
      const s = newScene();
      s.containers["comegin-prod-strapi/strapi"] = [];
      writeN8nEnv();
      const i = (await run(s))["onprem.strapi-image"];
      expect(i.level).toBe("unknown");
      expect(i.evidence).toContain("動いていない");
    });

    it("入力: イメージがまだ無い（No such image）と action で、ビルドのコマンドが出る", async () => {
      const s = newScene();
      delete s.images["comegin/strapi-onprem:local"];
      writeN8nEnv();
      const i = (await run(s))["onprem.strapi-image"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("node onprem/build.mjs strapi");
    });

    it("サーバ: git log が失敗すると、その item だけ unknown（ほかの item は続く）", async () => {
      const s = newScene();
      s.images["comegin/strapi-onprem:local"].labels = { "org.opencontainers.image.revision": SHA_OLD };
      s.logError = new Error("git log が失敗した");
      writeN8nEnv();
      const by = await run(s);
      expect(by["onprem.strapi-image"].level).toBe("unknown");
      expect(by["onprem.n8n-version"].level).toBe("ok");
    });
  });

  describe("異常系: onprem.n8n-image", () => {
    it("入力: 記録の後に onprem/n8n/Dockerfile を変えたコミットがあると action で、n8n のパスで log を引く", async () => {
      const s = newScene();
      s.images["comegin/n8n-onprem:2.39.5"].labels["org.opencontainers.image.revision"] = SHA_OLD;
      // n8n のパスで引いたときだけ変更がある（Strapi のパスで引いたときは無い）
      s.log = (args) => (args.includes("onprem/n8n/Dockerfile") ? logLine(SHA_NEW, "mod: n8n の Dockerfile") : "");
      writeN8nEnv();
      const calls = [];
      const by = await run(s, calls);
      expect(by["onprem.n8n-image"].level).toBe("action");
      expect(by["onprem.strapi-image"].level).toBe("ok");
      const log = calls.find((c) => c[0] === "git" && c[3] === "log" && c.includes(`${SHA_OLD}..origin/main`));
      expect(log).toContain("onprem/n8n/Dockerfile");
      expect(log).toContain("onprem/n8n/compose.yml");
    });

    it("入力: コンテナのイメージ ID が違うと action で sudo systemctl restart comegin-n8n", async () => {
      const s = newScene();
      s.containerImage.cn1 = OLD_IMAGE_ID;
      writeN8nEnv();
      const i = (await run(s))["onprem.n8n-image"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("再起動していない");
      expect(i.evidence).toContain("sudo systemctl restart comegin-n8n");
    });

    it("入力: イメージのラベルが空だと action で「記録が無い」", async () => {
      const s = newScene();
      s.images["comegin/n8n-onprem:2.39.5"].labels = { "com.comegin.n8n-version": "2.39.5", "com.comegin.n8n-digest": N8N_DIGEST };
      writeN8nEnv();
      const i = (await run(s))["onprem.n8n-image"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("記録が無い");
    });
  });

  describe("異常系: onprem.n8n-version", () => {
    it("入力: .env の N8N_VERSION が動いている n8n のラベルと違うと action で、根拠に版の文字列が出て、ほかの値は出ない", async () => {
      writeN8nEnv({ version: "2.40.0" });
      const s = newScene();
      s.example = envFileText({ version: "2.40.0" });
      const r = await check(ctxFor(s));
      const i = itemsByKey(r)["onprem.n8n-version"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("2.40.0");
      expect(i.evidence).toContain("2.39.5");
      const all = JSON.stringify(r);
      expect(all).not.toContain(DB_PASSWORD);
      expect(all).not.toContain("enc-key-secret-9876543210");
    });

    it("入力: N8N_DIGEST が動いている n8n のラベルと違うと action", async () => {
      const other = "sha256:" + "f".repeat(64);
      writeN8nEnv({ digest: other });
      const s = newScene();
      s.example = envFileText({ digest: other });
      const i = (await run(s))["onprem.n8n-version"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("N8N_DIGEST");
    });

    it("入力: N8N_RUNNERS_DIGEST が動いている runners のものと違うと action", async () => {
      const other = "sha256:" + "f".repeat(64);
      writeN8nEnv({ runners: other });
      const s = newScene();
      s.example = envFileText({ runners: other });
      const i = (await run(s))["onprem.n8n-version"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("N8N_RUNNERS_DIGEST");
    });

    it("入力: runners の版のタグと n8n の版が違うと action", async () => {
      writeN8nEnv();
      const s = newScene();
      s.containerConfigImage.cr1 = `ghcr.io/n8n-io/runners:2.38.0@${RUNNERS_DIGEST}`;
      const i = (await run(s))["onprem.n8n-version"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("2.38.0");
      expect(i.evidence).toContain("runners");
    });

    it("入力: .env.example が新しく .env が古いと action、逆なら warn", async () => {
      writeN8nEnv({ version: "2.39.5" });
      const s = newScene();
      s.example = envFileText({ version: "2.40.1" });
      const behind = (await run(s))["onprem.n8n-version"];
      expect(behind.level).toBe("action");
      expect(behind.evidence).toContain("2.40.1");

      // .env が先に上がった（動いているものも .env に追いついている）
      writeN8nEnv({ version: "2.41.0" });
      const s2 = newScene();
      s2.images["comegin/n8n-onprem:2.39.5"].labels["com.comegin.n8n-version"] = "2.41.0";
      s2.containerLabels.cn1["com.comegin.n8n-version"] = "2.41.0";
      s2.containerConfigImage.cr1 = `ghcr.io/n8n-io/runners:2.41.0@${RUNNERS_DIGEST}`;
      s2.example = envFileText({ version: "2.40.1" });
      const ahead = (await run(s2))["onprem.n8n-version"];
      expect(ahead.level).toBe("warn");
      expect(ahead.evidence).toContain("雛形");
    });

    it("入力: 版が同じでダイジェストだけ雛形と違うと、新旧を決められないので action", async () => {
      const other = "sha256:" + "f".repeat(64);
      writeN8nEnv({ digest: other });
      const s = newScene();
      s.containerLabels.cn1["com.comegin.n8n-digest"] = other;
      const i = (await run(s))["onprem.n8n-version"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("N8N_DIGEST");
    });

    it("入力: 雛形の版が数字とピリオドだけでなく新旧を比べられなくても、違えば action", async () => {
      writeN8nEnv({ version: "2.39.5" });
      const s = newScene();
      s.example = envFileText({ version: "next-build" });
      expect((await run(s))["onprem.n8n-version"].level).toBe("action");
    });

    it("入力: 3 つのキーのどれかが .env に無いと action（キーの名前だけが出る）", async () => {
      mkdirSync(join(worktree, "onprem/n8n"), { recursive: true });
      writeFileSync(join(worktree, "onprem/n8n", ".env"), `N8N_VERSION=2.39.5\nDB_POSTGRESDB_PASSWORD=${DB_PASSWORD}\n`);
      const r = await check(ctxFor(newScene()));
      const i = itemsByKey(r)["onprem.n8n-version"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("N8N_DIGEST");
      expect(JSON.stringify(r)).not.toContain(DB_PASSWORD);
    });

    it("入力: 環境変数ファイルが無いと action（./dev/init-env.sh）", async () => {
      const i = (await run(newScene()))["onprem.n8n-version"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("init-env.sh");
    });

    it("入力: n8n のコンテナが動いていないと、動いているものとの比較はできず warn", async () => {
      writeN8nEnv();
      const s = newScene();
      s.containers["comegin-prod-n8n/n8n"] = [];
      const i = (await run(s))["onprem.n8n-version"];
      expect(i.level).toBe("warn");
      expect(i.evidence).toContain("動いていない");
    });

    it("サーバ: git show で雛形を読めないと、雛形との比較だけ unknown（動いているものとの比較が ok なら unknown）", async () => {
      writeN8nEnv();
      const s = newScene();
      s.example = new Error("git show が失敗した（終了コード 128）");
      const i = (await run(s))["onprem.n8n-version"];
      expect(i.level).toBe("unknown");
      expect(i.evidence).toContain("雛形");
    });
  });

  describe("異常系: Docker に届かない", () => {
    it("入力: docker が無いと 3 つの item が unknown で、ok と notes は今と同じ", async () => {
      writeN8nEnv();
      const s = newScene();
      s.docker = false;
      const r = await check(ctxFor(s));
      expect(r.items.map((i) => [i.key, i.level, i.step])).toEqual(STRAPI_KEYS.map((k) => [k, "unknown", "P6"]));
      expect(r.items.every((i) => i.evidence.includes("docker"))).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.notes.some((n) => n.startsWith("! "))).toBe(false);
    });

    it("サーバ: docker のデーモンに届かない（docker ps が失敗）と 3 つの item が unknown", async () => {
      writeN8nEnv();
      const s = newScene();
      s.dockerError = new Error("docker ps が失敗した（終了コード 1）\nCannot connect to the Docker daemon");
      const by = await run(s);
      for (const k of STRAPI_KEYS) expect(by[k].level, k).toBe("unknown");
    });
  });
});
