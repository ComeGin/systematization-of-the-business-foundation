import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadControlPlaneConfig, resolveDataDir } from "../src/config.js";

const HOME = "/home/tester";
const BASE = { CONTROL_MAIN_CHECKOUT: "/srv/main", CONTROL_WORKTREE: "/srv/worktree" };

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // os.homedir() は HOME を見る
  vi.stubEnv("HOME", HOME);
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

/** 失敗させて、例外の文言と stderr に出た文言を返す。 */
function failWith(env: NodeJS.ProcessEnv): { message: string; logged: string } {
  try {
    loadControlPlaneConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return { message: (error as Error).message, logged: stderr.mock.calls.map((call) => String(call[0])).join("\n") };
  }
  throw new Error("ConfigError にならなかった");
}

describe("resolveDataDir", () => {
  it("未設定・空白だけなら ~/.local/share/comegin-control", () => {
    expect(resolveDataDir({})).toBe(`${HOME}/.local/share/comegin-control`);
    expect(resolveDataDir({ CONTROL_DATA_DIR: "  " })).toBe(`${HOME}/.local/share/comegin-control`);
  });

  it("~ と ~/ を展開し、それ以外はそのまま", () => {
    expect(resolveDataDir({ CONTROL_DATA_DIR: "~" })).toBe(HOME);
    expect(resolveDataDir({ CONTROL_DATA_DIR: "~/data" })).toBe(`${HOME}/data`);
    expect(resolveDataDir({ CONTROL_DATA_DIR: "/var/lib/cp" })).toBe("/var/lib/cp");
    expect(resolveDataDir({ CONTROL_DATA_DIR: "~other/x" })).toBe("~other/x");
  });
});

describe("loadControlPlaneConfig: 中核", () => {
  it("必須だけ設定すれば、任意の連携はすべて無効（null）で、スケジューラは止めたまま", () => {
    expect(loadControlPlaneConfig(BASE)).toEqual({
      dataDir: `${HOME}/.local/share/comegin-control`,
      mainCheckout: "/srv/main",
      worktree: "/srv/worktree",
      schedulerEnabled: false,
      agentHome: null,
      anthropic: null,
      siteUrl: null,
      github: null,
      aws: null,
      miswrite: null,
    });
  });

  it("引数を省くと process.env を読む", () => {
    vi.stubEnv("CONTROL_MAIN_CHECKOUT", "/from/env/main");
    vi.stubEnv("CONTROL_WORKTREE", "/from/env/wt");
    expect(loadControlPlaneConfig().mainCheckout).toBe("/from/env/main");
  });

  it("~/ のパスはホームに展開する", () => {
    const config = loadControlPlaneConfig({
      CONTROL_MAIN_CHECKOUT: "~/main",
      CONTROL_WORKTREE: "~/wt",
      CONTROL_DATA_DIR: "~/data",
      CONTROL_AGENT_HOME: "~/agent-home",
    });
    expect(config).toMatchObject({
      mainCheckout: `${HOME}/main`,
      worktree: `${HOME}/wt`,
      dataDir: `${HOME}/data`,
      agentHome: `${HOME}/agent-home`,
    });
  });

  it.each([
    ["未設定", {}],
    ["空文字（env ファイルの `VAR=`）", { CONTROL_MAIN_CHECKOUT: "", CONTROL_WORKTREE: "" }],
    ["相対パス", { CONTROL_MAIN_CHECKOUT: "main", CONTROL_WORKTREE: "./wt" }],
  ])("CONTROL_MAIN_CHECKOUT・CONTROL_WORKTREE が %s なら ConfigError", (_label, env) => {
    const { message } = failWith(env);
    expect(message).toMatch(/CONTROL_MAIN_CHECKOUT/);
    expect(message).toMatch(/CONTROL_WORKTREE/);
  });

  it.each([
    ["CONTROL_DATA_DIR", "data"],
    ["CONTROL_DATA_DIR", "./data"],
    ["CONTROL_AGENT_HOME", "agent-home"],
  ])("%s が相対パス（%s）なら ConfigError（cwd 次第で作業ツリーの中を指しうるため）", (name, value) => {
    expect(failWith({ ...BASE, [name]: value }).message).toMatch(new RegExp(`${name}.*絶対パス`));
  });

  it("CONTROL_SCHEDULER_ENABLED は true / false だけ（空は false）", () => {
    expect(loadControlPlaneConfig({ ...BASE, CONTROL_SCHEDULER_ENABLED: "true" }).schedulerEnabled).toBe(true);
    expect(loadControlPlaneConfig({ ...BASE, CONTROL_SCHEDULER_ENABLED: "" }).schedulerEnabled).toBe(false);
    expect(failWith({ ...BASE, CONTROL_SCHEDULER_ENABLED: "yes" }).message).toMatch(/CONTROL_SCHEDULER_ENABLED/);
  });

  it("ANTHROPIC_API_KEY と SITE_URL は設定されていれば使う", () => {
    const config = loadControlPlaneConfig({ ...BASE, ANTHROPIC_API_KEY: "sk-ant-x", SITE_URL: "https://comegin.com" });
    expect(config.anthropic).toEqual({ apiKey: "sk-ant-x" });
    expect(config.siteUrl).toBe("https://comegin.com");
  });
});

describe("loadControlPlaneConfig: グループ（全部未設定か全部設定）", () => {
  const GITHUB = {
    GITHUB_TOKEN: "ghp_x",
    GITHUB_REPOSITORY: "kamegin4-aws/repo.name",
    I13_ISSUE_NUMBER: "13",
    I13_REVIEWER: "reviewer",
  };
  const MISWRITE = {
    MISWRITE_CHATWOOT_BASE_URL: "https://chat.example.com//",
    MISWRITE_CHATWOOT_ACCOUNT_ID: "2",
    MISWRITE_CHATWOOT_API_TOKEN: "tok",
    MISWRITE_AGENT_USER_ID: "7",
  };

  it("GitHub は全部そろえば有効で、数値を変換し、ベースブランチの既定は main", () => {
    expect(loadControlPlaneConfig({ ...BASE, ...GITHUB }).github).toEqual({
      token: "ghp_x",
      repository: "kamegin4-aws/repo.name",
      baseBranch: "main",
      issueNumber: 13,
      reviewer: "reviewer",
    });
  });

  it("AWS は REGION と BUCKET で有効になり、PROFILE と名前空間は任意", () => {
    expect(loadControlPlaneConfig({ ...BASE, AWS_REGION: "ap-northeast-1", RUNLOG_BUCKET: "b" }).aws).toEqual({
      region: "ap-northeast-1",
      profile: null,
      runlogBucket: "b",
      heartbeatNamespace: "ComeGin/Onprem",
    });
  });

  it("突き合わせは全部そろえば有効で、ベース URL の末尾の / を落とす", () => {
    expect(loadControlPlaneConfig({ ...BASE, ...MISWRITE }).miswrite).toEqual({
      baseUrl: "https://chat.example.com",
      accountId: 2,
      apiToken: "tok",
      agentUserId: 7,
    });
  });

  it("一部だけの設定は、足りない変数の名前を挙げて ConfigError", () => {
    const { message } = failWith({ ...BASE, GITHUB_TOKEN: "ghp_x", I13_REVIEWER: "r" });
    expect(message).toMatch(/GITHUB_REPOSITORY: GitHub（I-13） の他の変数が設定されているため必須です/);
    expect(message).toMatch(/I13_ISSUE_NUMBER: /);
    expect(message).not.toMatch(/GITHUB_TOKEN: /);
  });

  it("空文字は未設定と同じに扱う（全部空ならグループは無効でエラーにしない）", () => {
    const empty = Object.fromEntries(Object.keys(MISWRITE).map((key) => [key, ""]));
    expect(loadControlPlaneConfig({ ...BASE, ...empty }).miswrite).toBeNull();
  });

  it("AWS_PROFILE だけの設定は設定漏れとして REGION と BUCKET を求める", () => {
    const { message } = failWith({ ...BASE, AWS_PROFILE: "comegin" });
    expect(message).toMatch(/AWS_REGION: AWS_PROFILE が設定されているため必須です/);
    expect(message).toMatch(/RUNLOG_BUCKET: AWS_PROFILE が設定されているため必須です/);
  });

  it.each([
    ["GITHUB_REPOSITORY", { ...GITHUB, GITHUB_REPOSITORY: "no-slash" }],
    ["I13_ISSUE_NUMBER", { ...GITHUB, I13_ISSUE_NUMBER: "0" }],
    ["MISWRITE_CHATWOOT_ACCOUNT_ID", { ...MISWRITE, MISWRITE_CHATWOOT_ACCOUNT_ID: "abc" }],
    ["MISWRITE_CHATWOOT_BASE_URL", { ...MISWRITE, MISWRITE_CHATWOOT_BASE_URL: "not a url" }],
  ])("%s の形が不正なら ConfigError", (name, env) => {
    expect(failWith({ ...BASE, ...env }).message).toMatch(new RegExp(`${name}: `));
  });
});

describe("loadControlPlaneConfig: エラーの出し方", () => {
  it("変数名と理由だけを stderr に出し、値（秘密値を含む）は例外にもログにも出さない", () => {
    const secret = "ghp_SUPERSECRETVALUE_1234567890";
    const { message, logged } = failWith({
      ...BASE,
      GITHUB_TOKEN: secret,
      MISWRITE_CHATWOOT_BASE_URL: "secret-host-without-scheme",
      MISWRITE_CHATWOOT_API_TOKEN: "chatwoot-token-zzz",
    });
    expect(message).toMatch(/^環境変数が不正です:/);
    expect(logged).toMatch(/ERROR config 環境変数が不正です:/);
    for (const value of [secret, "secret-host-without-scheme", "chatwoot-token-zzz"]) {
      expect(message).not.toContain(value);
      expect(logged).not.toContain(value);
    }
  });

  it("process.exit を呼ばずに例外で返す（ライブラリなので）", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit が呼ばれた");
    });
    expect(() => loadControlPlaneConfig({})).toThrow(ConfigError);
    expect(exit).not.toHaveBeenCalled();
  });
});
