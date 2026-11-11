// cloud/deploy.mjs（sam deploy の包み）と cloud/images/build-push.mjs（イメージのビルドとプッシュの包み）の単体テスト。
// git・sam・docker は偽物（run）に差し替え、呼ばれた順番と引数を確かめる。実際のコマンド・AWS・デプロイ設定ファイルには触れない。
import { describe, expect, it } from "vitest";
import { runDeploy } from "../../../cloud/deploy.mjs";
import { recordTag, runBuildPush } from "../../../cloud/images/build-push.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * 偽の run。git status は dirty の行を返し、rev-parse は SHA を返す。ほかは空文字を返して呼び出しを記録する
 * （merge-base --is-ancestor も成功 = HEAD は origin/main の履歴にある）。failOn が数を返したら、その終了コードの失敗にする
 */
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
const SAM_TOML = `
[default.deploy.parameters]
parameter_overrides = [
  "EnvName=prod",
  "GoogleClientId=do-not-print.apps.example",
  "DeployedCommit=unrecorded",
  "ChatwootImageTag=v4.18.0-1",
  "MauticImageTag=7.2.0-3",
]

[global.deploy.parameters]
parameter_overrides = [
  "EnvName=prod",
]
`;
const logs = () => {
  const lines = [];
  return { lines, log: (s) => lines.push(s) };
};

describe("runDeploy: 正常系", () => {
  it("入力: default は sam build → sam deploy の順で、cwd は cloud/、末尾が DeployedCommit=<40 桁>", async () => {
    const { run, calls } = fakeRun();
    const { log } = logs();
    await runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, log });
    const cmds = nonGit(calls);
    expect(cmds.map((c) => [c.cmd, c.args[0]])).toEqual([
      ["sam", "build"],
      ["sam", "deploy"],
    ]);
    expect(cmds.every((c) => c.opts.cwd === "/repo/cloud")).toBe(true);
    // 人が変更セットの確認に答えられるように、画面を引き継ぐ
    expect(cmds.every((c) => c.opts.inherit === true)).toBe(true);
    const deploy = cmds[1].args;
    expect(deploy).not.toContain("--config-env");
    expect(deploy[deploy.indexOf("--parameter-overrides") + 1]).toBe("EnvName=prod");
    expect(deploy.at(-1)).toBe(`DeployedCommit=${SHA}`);
    // 既存の DeployedCommit=unrecorded は 1 つに置き換わる
    expect(deploy.filter((a) => a.startsWith("DeployedCommit="))).toHaveLength(1);
    expect(deploy).toContain("MauticImageTag=7.2.0-3");
  });

  it("入力: global は sam build を呼ばず、--config-env global を付ける", async () => {
    const { run, calls } = fakeRun();
    const { log } = logs();
    await runDeploy({ env: "global", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, log });
    const cmds = nonGit(calls);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].args.slice(0, 3)).toEqual(["deploy", "--config-env", "global"]);
    expect(cmds[0].args.slice(3)).toEqual(["--parameter-overrides", "EnvName=prod", `DeployedCommit=${SHA}`]);
  });

  it("入力: 未コミットの確認は default で cloud と Lambda の 3 パッケージ、global で cloud だけ", async () => {
    const a = fakeRun();
    await runDeploy({ env: "default", repoDir: "/repo", run: a.run, readSamconfig: () => SAM_TOML, log: () => {} });
    const statusDefault = a.calls.find((c) => c.args.includes("status")).args;
    expect(statusDefault.slice(statusDefault.indexOf("--") + 1)).toEqual(["cloud", "backend/faq-bot", "backend/consent-api", "backend/admin-auth"]);
    const b = fakeRun();
    await runDeploy({ env: "global", repoDir: "/repo", run: b.run, readSamconfig: () => SAM_TOML, log: () => {} });
    const statusGlobal = b.calls.find((c) => c.args.includes("status")).args;
    expect(statusGlobal.slice(statusGlobal.indexOf("--") + 1)).toEqual(["cloud"]);
  });

  it("入力: 画面に出すのはパラメータの数と短い SHA だけで、値は出さない", async () => {
    const { run } = fakeRun();
    const { lines, log } = logs();
    await runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, log });
    const text = lines.join("\n");
    expect(text).toContain(SHA.slice(0, 7));
    expect(text).not.toContain(SHA);
    expect(text).not.toContain("do-not-print");
    expect(text).not.toContain("EnvName=prod");
  });

  it("入力: 終わりの表示は「記録した」と言い切らず、変更セットを断った場合と確かめ方を添える", async () => {
    const { run } = fakeRun();
    const { lines, log } = logs();
    await runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, log });
    const last = lines.at(-1);
    expect(last).toContain("sam deploy が終わった");
    expect(last).toContain("変更セットを断った場合は記録されていない");
    expect(last).toContain("--check");
    expect(last).not.toMatch(/^完了/);
  });

  it("入力: HEAD が origin/main の履歴に無い（merge-base --is-ancestor が 1）と、止めずに警告を出して deploy する", async () => {
    const { run, calls } = fakeRun({ failOn: (cmd, args) => cmd === "git" && args.includes("--is-ancestor") && 1 });
    const { lines, log } = logs();
    await runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, log });
    const isAncestor = calls.find((c) => c.args.includes("--is-ancestor")).args;
    expect(isAncestor.slice(-2)).toEqual([SHA, "origin/main"]);
    expect(lines.join("\n")).toMatch(/origin\/main の履歴に無い[\s\S]*!/);
    expect(nonGit(calls).map((c) => c.args[0])).toEqual(["build", "deploy"]);
  });

  it("入力: HEAD が origin/main の履歴にあれば、警告を出さない", async () => {
    const { run } = fakeRun();
    const { lines, log } = logs();
    await runDeploy({ env: "global", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, log });
    expect(lines.join("\n")).not.toContain("注意");
  });
});

describe("runDeploy: 異常系", () => {
  it("入力: 未コミットの行があると sam を呼ばずに止まり、行を知らせる", async () => {
    const { run, calls } = fakeRun({ dirty: " M cloud/template.yaml\n?? backend/faq-bot/x.ts\n" });
    await expect(runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, log: () => {} })).rejects.toThrow(/未コミット[\s\S]*cloud\/template\.yaml/);
    expect(nonGit(calls)).toEqual([]);
    // HEAD も取らない（止めるのが先）
    expect(calls.some((c) => c.args.includes("rev-parse"))).toBe(false);
  });

  it("入力: sam build が失敗したら sam deploy を呼ばない", async () => {
    const { run, calls } = fakeRun({ failOn: (cmd, args) => cmd === "sam" && args[0] === "build" });
    await expect(runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, log: () => {} })).rejects.toThrow(/sam/);
    expect(nonGit(calls).map((c) => c.args[0])).toEqual(["build"]);
  });

  it("入力: 知らない env は何も呼ばずに例外", async () => {
    const { run, calls } = fakeRun();
    await expect(runDeploy({ env: "staging", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, log: () => {} })).rejects.toThrow(/default|global/);
    expect(calls).toEqual([]);
  });

  it("空入力: 設定ファイルが空（表が無い）だと sam を呼ばずに止まる（DeployedCommit だけでは進まない）", async () => {
    const { run, calls } = fakeRun();
    await expect(runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => "", log: () => {} })).rejects.toThrow(/\[default\.deploy\.parameters\][\s\S]*1 つも読めない/);
    expect(nonGit(calls)).toEqual([]);
  });

  it("入力: global の表だけがあり default の表が無いと、default は止まる", async () => {
    const { run, calls } = fakeRun();
    const toml = `[global.deploy.parameters]\nparameter_overrides = ["EnvName=prod"]\n`;
    await expect(runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => toml, log: () => {} })).rejects.toThrow(/1 つも読めない/);
    expect(nonGit(calls)).toEqual([]);
  });

  it("入力: 表はあるが parameter_overrides のキーが無いと止まる", async () => {
    const { run, calls } = fakeRun();
    const toml = `[default.deploy.parameters]\nstack_name = "comegin-prod"\n`;
    await expect(runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => toml, log: () => {} })).rejects.toThrow(/1 つも読めない/);
    expect(nonGit(calls)).toEqual([]);
  });

  it("入力: ドット区切りのキーで書いてあると（この形は読まない）止まり、値を例外の文に出さない", async () => {
    const { run, calls } = fakeRun();
    const toml = `[default]\ndeploy.parameters.parameter_overrides = ["GoogleClientId=do-not-print.apps.example"]\n`;
    const err = await runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => toml, log: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("ドット区切り");
    expect(err.message).not.toContain("do-not-print");
    expect(nonGit(calls)).toEqual([]);
  });

  it("入力: DeployedCommit しか書いていないと止まる", async () => {
    const { run, calls } = fakeRun();
    const toml = `[default.deploy.parameters]\nparameter_overrides = ["DeployedCommit=unrecorded"]\n`;
    await expect(runDeploy({ env: "default", repoDir: "/repo", run, readSamconfig: () => toml, log: () => {} })).rejects.toThrow(/1 つも読めない/);
    expect(nonGit(calls)).toEqual([]);
  });

  it("サーバ: origin/main を読めない（merge-base が 128）ときも止めず、「確かめられない」と警告して deploy する", async () => {
    const { run, calls } = fakeRun({ failOn: (cmd, args) => cmd === "git" && args.includes("--is-ancestor") && 128 });
    const { lines, log } = logs();
    await runDeploy({ env: "global", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, log });
    expect(lines.join("\n")).toContain("確かめられない");
    expect(nonGit(calls).map((c) => c.args[0])).toEqual(["deploy"]);
  });
});

describe("runBuildPush: 正常系", () => {
  const ACCOUNT = "123456789012";
  const ECR = `${ACCOUNT}.dkr.ecr.ap-northeast-1.amazonaws.com`;

  it("入力: chatwoot は本来のタグと <タグ>-rev-<SHA> の 2 つを付けて build し、2 つとも push する", async () => {
    const { run, calls } = fakeRun();
    const { log } = logs();
    await runBuildPush({ product: "chatwoot", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, account: ACCOUNT, log });
    const cmds = nonGit(calls);
    expect(cmds.map((c) => [c.cmd, c.args[0]])).toEqual([
      ["docker", "build"],
      ["docker", "push"],
      ["docker", "push"],
    ]);
    const base = `${ECR}/comegin/prod/chatwoot:v4.18.0-1`;
    const rev = `${ECR}/comegin/prod/chatwoot:v4.18.0-1-rev-${SHA}`;
    expect(cmds[0].args).toEqual([
      "build",
      "--platform",
      "linux/amd64",
      "--label",
      `org.opencontainers.image.revision=${SHA}`,
      "--build-arg",
      "UPSTREAM_TAG=v4.18.0",
      "--build-arg",
      "UPSTREAM_DIGEST=sha256:b419dded7e9d2f54a24fd427b74ba7e6069d601b500618045c1eb6c01a1cc9a1",
      "-t",
      base,
      "-t",
      rev,
      "cloud/images/chatwoot",
    ]);
    expect(cmds[1].args).toEqual(["push", base]);
    expect(cmds[2].args).toEqual(["push", rev]);
    expect(cmds.every((c) => c.opts.cwd === "/repo" && c.opts.inherit === true)).toBe(true);
  });

  it("入力: mautic は MauticImageTag と mautic の上流の値を使う", async () => {
    const { run, calls } = fakeRun();
    await runBuildPush({ product: "mautic", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, account: ACCOUNT, log: () => {} });
    const build = nonGit(calls)[0].args;
    expect(build).toContain("UPSTREAM_TAG=7.2.0-apache");
    expect(build).toContain(`${ECR}/comegin/prod/mautic:7.2.0-3-rev-${SHA}`);
    expect(build.at(-1)).toBe("cloud/images/mautic");
  });

  it("入力: 未コミットの確認は cloud/images/<製品> だけ", async () => {
    const { run, calls } = fakeRun();
    await runBuildPush({ product: "mautic", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, account: ACCOUNT, log: () => {} });
    const status = calls.find((c) => c.args.includes("status")).args;
    expect(status.slice(status.indexOf("--") + 1)).toEqual(["cloud/images/mautic"]);
  });

  it("入力: 記録のタグが 128 文字ちょうどなら通る", () => {
    const tag = "t".repeat(128 - `-rev-${SHA}`.length);
    expect(recordTag(tag, SHA)).toHaveLength(128);
  });
});

describe("runBuildPush: 異常系", () => {
  const ACCOUNT = "123456789012";

  it("入力: 未コミットの行があると docker を呼ばずに止まる", async () => {
    const { run, calls } = fakeRun({ dirty: " M cloud/images/chatwoot/Dockerfile\n" });
    await expect(runBuildPush({ product: "chatwoot", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, account: ACCOUNT, log: () => {} })).rejects.toThrow(/未コミット/);
    expect(nonGit(calls)).toEqual([]);
  });

  it("入力: 知らない製品は何も呼ばずに例外", async () => {
    const { run, calls } = fakeRun();
    await expect(runBuildPush({ product: "strapi", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, account: ACCOUNT, log: () => {} })).rejects.toThrow(/chatwoot.*mautic/);
    expect(calls).toEqual([]);
  });

  it("空入力: samconfig にタグのパラメータが無いと、docker を呼ばずに例外", async () => {
    const { run, calls } = fakeRun();
    await expect(runBuildPush({ product: "chatwoot", repoDir: "/repo", run, readSamconfig: () => "", account: ACCOUNT, log: () => {} })).rejects.toThrow(/ChatwootImageTag/);
    expect(nonGit(calls)).toEqual([]);
  });

  it("入力: 記録のタグが 128 文字を超えると docker を呼ばずに例外", async () => {
    const longTag = "t".repeat(100);
    const toml = `[default.deploy.parameters]\nparameter_overrides = ["ChatwootImageTag=${longTag}"]\n`;
    const { run, calls } = fakeRun();
    await expect(runBuildPush({ product: "chatwoot", repoDir: "/repo", run, readSamconfig: () => toml, account: ACCOUNT, log: () => {} })).rejects.toThrow(/128/);
    expect(nonGit(calls)).toEqual([]);
  });

  it("入力: アカウント ID が 12 桁の数字でないと例外", async () => {
    const { run, calls } = fakeRun();
    await expect(runBuildPush({ product: "chatwoot", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, account: "abc", log: () => {} })).rejects.toThrow(/アカウント/);
    expect(nonGit(calls)).toEqual([]);
  });

  it("入力: 2 つ目（記録のタグ）の push だけが失敗したら、docker push <記録のタグ> の打ち直しを示して止まり、再実行では直らないと書く", async () => {
    const rev = `${ACCOUNT}.dkr.ecr.ap-northeast-1.amazonaws.com/comegin/prod/chatwoot:v4.18.0-1-rev-${SHA}`;
    const { run, calls } = fakeRun({ failOn: (cmd, args) => cmd === "docker" && args[0] === "push" && args[1] === rev });
    const err = await runBuildPush({ product: "chatwoot", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, account: ACCOUNT, log: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(`docker push ${rev}`);
    expect(err.message).toContain("再実行では直らない");
    expect(err.message).not.toContain("do-not-print");
    expect(nonGit(calls).map((c) => c.args[0])).toEqual(["build", "push", "push"]);
  });

  it("入力: build が失敗したら push しない", async () => {
    const { run, calls } = fakeRun({ failOn: (cmd, args) => cmd === "docker" && args[0] === "build" });
    await expect(runBuildPush({ product: "chatwoot", repoDir: "/repo", run, readSamconfig: () => SAM_TOML, account: ACCOUNT, log: () => {} })).rejects.toThrow();
    expect(nonGit(calls).map((c) => c.args[0])).toEqual(["build"]);
  });
});
