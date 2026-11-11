// onprem/build.mjs（オンプレの本番のイメージの docker compose build の包み）の単体テスト。
// git・docker は偽物（run）に差し替え、呼ばれた順番と引数・環境変数を確かめる。実際のコマンド・環境変数ファイルには触れない。
import { describe, expect, it } from "vitest";
import { runOnpremBuild } from "../../../onprem/build.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** 偽の run。git status は dirty の行を返し、rev-parse は SHA を返す。failOn が数を返したら、その終了コードの失敗にする */
function fakeRun({ dirty = "", failOn = null } = {}) {
  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    const failed = failOn ? failOn(cmd, args) : false;
    if (failed) throw Object.assign(new Error(`${cmd} が失敗した`), { exitCode: typeof failed === "number" ? failed : 1 });
    if (cmd === "git" && args.includes("status")) return dirty;
    if (cmd === "git" && args.includes("rev-parse")) return `${SHA}\n`;
    return "";
  };
  return { run, calls };
}
const nonGit = (calls) => calls.filter((c) => c.cmd !== "git");
const logs = () => {
  const lines = [];
  return { lines, log: (s) => lines.push(s) };
};
const statusPaths = (calls) => {
  const args = calls.find((c) => c.args.includes("status")).args;
  return args.slice(args.indexOf("--") + 1);
};

describe("runOnpremBuild: 正常系", () => {
  it("入力: strapi は GIT_COMMIT=<40 桁> を付けて docker compose -f onprem/strapi/compose.yml build strapi を、ルートで画面を引き継いで動かす", async () => {
    const { run, calls } = fakeRun();
    const { log } = logs();
    await runOnpremBuild({ name: "strapi", repoDir: "/repo", run, log });
    const cmds = nonGit(calls);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].cmd).toBe("docker");
    expect(cmds[0].args).toEqual(["compose", "-f", "onprem/strapi/compose.yml", "build", "strapi"]);
    expect(cmds[0].opts.cwd).toBe("/repo");
    expect(cmds[0].opts.inherit).toBe(true);
    expect(cmds[0].opts.env.GIT_COMMIT).toBe(SHA);
    expect(cmds[0].opts.env.GIT_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  it("入力: n8n は onprem/n8n/compose.yml の n8n サービスだけをビルドする（runners・webhook-proxy は pull するだけ）", async () => {
    const { run, calls } = fakeRun();
    await runOnpremBuild({ name: "n8n", repoDir: "/repo", run, log: () => {} });
    const cmds = nonGit(calls);
    expect(cmds[0].args).toEqual(["compose", "-f", "onprem/n8n/compose.yml", "build", "n8n"]);
    expect(cmds[0].opts.env).toEqual({ GIT_COMMIT: SHA });
  });

  it("入力: 未コミットの確認は、strapi で backend/strapi-system と onprem/strapi、n8n で onprem/n8n", async () => {
    const a = fakeRun();
    await runOnpremBuild({ name: "strapi", repoDir: "/repo", run: a.run, log: () => {} });
    expect(statusPaths(a.calls)).toEqual(["backend/strapi-system", "onprem/strapi"]);
    const b = fakeRun();
    await runOnpremBuild({ name: "n8n", repoDir: "/repo", run: b.run, log: () => {} });
    expect(statusPaths(b.calls)).toEqual(["onprem/n8n"]);
  });

  it("入力: 終わりに再起動の案内（sudo systemctl restart comegin-<名前>）を出す。画面に出す SHA は短い形だけ", async () => {
    const { run } = fakeRun();
    const { lines, log } = logs();
    await runOnpremBuild({ name: "n8n", repoDir: "/repo", run, log });
    expect(lines.at(-1)).toContain("sudo systemctl restart comegin-n8n");
    const text = lines.join("\n");
    expect(text).toContain(SHA.slice(0, 7));
    expect(text).not.toContain(SHA);
  });

  it("入力: noCache なら build の後に --no-cache を付ける", async () => {
    const { run, calls } = fakeRun();
    await runOnpremBuild({ name: "strapi", repoDir: "/repo", run, noCache: true, log: () => {} });
    expect(nonGit(calls)[0].args).toEqual(["compose", "-f", "onprem/strapi/compose.yml", "build", "--no-cache", "strapi"]);
  });

  it("入力: HEAD が origin/main の履歴に無い（merge-base --is-ancestor が 1）と、止めずに警告を出してビルドする", async () => {
    const { run, calls } = fakeRun({ failOn: (cmd, args) => cmd === "git" && args.includes("--is-ancestor") && 1 });
    const { lines, log } = logs();
    await runOnpremBuild({ name: "strapi", repoDir: "/repo", run, log });
    expect(lines.join("\n")).toMatch(/origin\/main の履歴に無い[\s\S]*!/);
    expect(nonGit(calls)).toHaveLength(1);
  });

  it("入力: HEAD が origin/main の履歴にあれば、警告を出さない", async () => {
    const { run } = fakeRun();
    const { lines, log } = logs();
    await runOnpremBuild({ name: "strapi", repoDir: "/repo", run, log });
    expect(lines.join("\n")).not.toContain("注意");
  });
});

describe("runOnpremBuild: 異常系", () => {
  it("入力: 未コミットの行があると docker を呼ばずに止まり、行を知らせる。HEAD も取らない", async () => {
    const { run, calls } = fakeRun({ dirty: " M backend/strapi-system/config/plugins.ts\n" });
    await expect(runOnpremBuild({ name: "strapi", repoDir: "/repo", run, log: () => {} })).rejects.toThrow(/未コミット[\s\S]*plugins\.ts/);
    expect(nonGit(calls)).toEqual([]);
    expect(calls.some((c) => c.args.includes("rev-parse"))).toBe(false);
  });

  it("入力: 知らない名前は何も呼ばずに例外", async () => {
    const { run, calls } = fakeRun();
    await expect(runOnpremBuild({ name: "mautic", repoDir: "/repo", run, log: () => {} })).rejects.toThrow(/strapi.*n8n/);
    expect(calls).toEqual([]);
  });

  it("入力: docker compose build が失敗したら、再起動の案内を出さずに例外", async () => {
    const { run } = fakeRun({ failOn: (cmd) => cmd === "docker" });
    const { lines, log } = logs();
    await expect(runOnpremBuild({ name: "n8n", repoDir: "/repo", run, log })).rejects.toThrow(/docker/);
    expect(lines.join("\n")).not.toContain("systemctl restart");
  });

  it("サーバ: origin/main を読めない（merge-base が 128）ときも止めず、「確かめられない」と警告してビルドする", async () => {
    const { run, calls } = fakeRun({ failOn: (cmd, args) => cmd === "git" && args.includes("--is-ancestor") && 128 });
    const { lines, log } = logs();
    await runOnpremBuild({ name: "n8n", repoDir: "/repo", run, log });
    expect(lines.join("\n")).toContain("確かめられない");
    expect(nonGit(calls)).toHaveLength(1);
  });
});
