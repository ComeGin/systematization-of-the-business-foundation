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
  describe("正常系", () => {
    it("空入力: 未設定・空白だけなら ~/.local/share/comegin-control", () => {
      expect(resolveDataDir({})).toBe(`${HOME}/.local/share/comegin-control`);
      expect(resolveDataDir({ CONTROL_DATA_DIR: "  " })).toBe(`${HOME}/.local/share/comegin-control`);
      expect(resolveDataDir({ CONTROL_DATA_DIR: "" })).toBe(`${HOME}/.local/share/comegin-control`);
    });

    it("~ と ~/ を展開し、それ以外はそのまま", () => {
      expect(resolveDataDir({ CONTROL_DATA_DIR: "~" })).toBe(HOME);
      expect(resolveDataDir({ CONTROL_DATA_DIR: "~/data" })).toBe(`${HOME}/data`);
      expect(resolveDataDir({ CONTROL_DATA_DIR: "/var/lib/cp" })).toBe("/var/lib/cp");
      expect(resolveDataDir({ CONTROL_DATA_DIR: "~other/x" })).toBe("~other/x");
    });

    it("前後の空白を落としてから解決する", () => {
      expect(resolveDataDir({ CONTROL_DATA_DIR: "  /var/lib/cp  " })).toBe("/var/lib/cp");
    });
  });
});

describe("loadControlPlaneConfig: 中核", () => {
  describe("正常系", () => {
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
        n8nExport: null,
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

    it("CONTROL_SCHEDULER_ENABLED は true なら有効", () => {
      expect(loadControlPlaneConfig({ ...BASE, CONTROL_SCHEDULER_ENABLED: "true" }).schedulerEnabled).toBe(true);
      expect(loadControlPlaneConfig({ ...BASE, CONTROL_SCHEDULER_ENABLED: "false" }).schedulerEnabled).toBe(false);
    });

    it("空入力: CONTROL_SCHEDULER_ENABLED が空文字なら false", () => {
      expect(loadControlPlaneConfig({ ...BASE, CONTROL_SCHEDULER_ENABLED: "" }).schedulerEnabled).toBe(false);
    });

    it("ANTHROPIC_API_KEY と SITE_URL は設定されていれば使う", () => {
      const config = loadControlPlaneConfig({ ...BASE, ANTHROPIC_API_KEY: "sk-ant-x", SITE_URL: "https://comegin.com" });
      expect(config.anthropic).toEqual({ apiKey: "sk-ant-x" });
      expect(config.siteUrl).toBe("https://comegin.com");
    });

    it("空入力: 任意の変数が空文字・空白だけなら未設定と同じに扱う（env ファイルの `VAR=`）", () => {
      const config = loadControlPlaneConfig({
        ...BASE,
        CONTROL_DATA_DIR: "",
        CONTROL_AGENT_HOME: "  ",
        ANTHROPIC_API_KEY: "",
        SITE_URL: " ",
        CONTROL_N8N_EXPORT_URL: "",
        CONTROL_N8N_EXPORT_API_KEY: "",
      });
      expect(config).toMatchObject({
        dataDir: `${HOME}/.local/share/comegin-control`,
        agentHome: null,
        anthropic: null,
        siteUrl: null,
        n8nExport: null,
      });
    });
  });

  describe("異常系", () => {
    it.each([
      ["未設定", {}],
      ["空文字（env ファイルの `VAR=`）", { CONTROL_MAIN_CHECKOUT: "", CONTROL_WORKTREE: "" }],
      ["空白だけ", { CONTROL_MAIN_CHECKOUT: "   ", CONTROL_WORKTREE: "\t" }],
    ])("空入力: CONTROL_MAIN_CHECKOUT・CONTROL_WORKTREE が %s なら ConfigError", (_label, env) => {
      const { message } = failWith(env);
      expect(message).toMatch(/CONTROL_MAIN_CHECKOUT/);
      expect(message).toMatch(/CONTROL_WORKTREE/);
    });

    it("入力: CONTROL_MAIN_CHECKOUT・CONTROL_WORKTREE が相対パスなら ConfigError", () => {
      const { message } = failWith({ CONTROL_MAIN_CHECKOUT: "main", CONTROL_WORKTREE: "./wt" });
      expect(message).toMatch(/CONTROL_MAIN_CHECKOUT: 絶対パス/);
      expect(message).toMatch(/CONTROL_WORKTREE: 絶対パス/);
    });

    it.each([
      ["CONTROL_DATA_DIR", "data"],
      ["CONTROL_DATA_DIR", "./data"],
      ["CONTROL_AGENT_HOME", "agent-home"],
    ])("入力: %s が相対パス（%s）なら ConfigError（cwd 次第で作業ツリーの中を指しうるため）", (name, value) => {
      expect(failWith({ ...BASE, [name]: value }).message).toMatch(new RegExp(`${name}.*絶対パス`));
    });

    it.each(["yes", "1", "TRUE"])("入力: CONTROL_SCHEDULER_ENABLED が true / false 以外（%s）なら ConfigError", (value) => {
      expect(failWith({ ...BASE, CONTROL_SCHEDULER_ENABLED: value }).message).toMatch(/CONTROL_SCHEDULER_ENABLED/);
    });

    it("入力: SITE_URL が URL の形でなければ ConfigError", () => {
      expect(failWith({ ...BASE, SITE_URL: "comegin.com" }).message).toMatch(/SITE_URL: /);
    });
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

  describe("正常系", () => {
    it("GitHub は全部そろえば有効で、数値を変換し、ベースブランチの既定は main", () => {
      expect(loadControlPlaneConfig({ ...BASE, ...GITHUB }).github).toEqual({
        token: "ghp_x",
        repository: "kamegin4-aws/repo.name",
        baseBranch: "main",
        issueNumber: 13,
        reviewer: "reviewer",
      });
    });

    it("GITHUB_BASE_BRANCH を設定すればそのブランチを使う（グループの必須には含めない）", () => {
      expect(loadControlPlaneConfig({ ...BASE, ...GITHUB, GITHUB_BASE_BRANCH: "develop" }).github?.baseBranch).toBe("develop");
      expect(loadControlPlaneConfig({ ...BASE, GITHUB_BASE_BRANCH: "develop" }).github).toBeNull();
    });

    it("AWS は REGION と BUCKET で有効になり、PROFILE と名前空間は任意", () => {
      expect(loadControlPlaneConfig({ ...BASE, AWS_REGION: "ap-northeast-1", RUNLOG_BUCKET: "b" }).aws).toEqual({
        region: "ap-northeast-1",
        profile: null,
        runlogBucket: "b",
        heartbeatNamespace: "ComeGin/Onprem",
      });
      expect(
        loadControlPlaneConfig({
          ...BASE,
          AWS_REGION: "ap-northeast-1",
          RUNLOG_BUCKET: "b",
          AWS_PROFILE: "comegin-onprem",
          HEARTBEAT_NAMESPACE: "ComeGin/Test",
        }).aws,
      ).toMatchObject({ profile: "comegin-onprem", heartbeatNamespace: "ComeGin/Test" });
    });

    it("突き合わせは全部そろえば有効で、ベース URL の末尾の / を落とす", () => {
      expect(loadControlPlaneConfig({ ...BASE, ...MISWRITE }).miswrite).toEqual({
        baseUrl: "https://chat.example.com",
        accountId: 2,
        apiToken: "tok",
        agentUserId: 7,
      });
    });

    it("空入力: 空文字は未設定と同じに扱う（全部空ならグループは無効でエラーにしない）", () => {
      const empty = Object.fromEntries(Object.keys(MISWRITE).map((key) => [key, ""]));
      expect(loadControlPlaneConfig({ ...BASE, ...empty }).miswrite).toBeNull();
      const emptyGithub = Object.fromEntries(Object.keys(GITHUB).map((key) => [key, " "]));
      expect(loadControlPlaneConfig({ ...BASE, ...emptyGithub }).github).toBeNull();
    });
  });

  describe("異常系", () => {
    it("入力: 一部だけの設定は、足りない変数の名前を挙げて ConfigError", () => {
      const { message } = failWith({ ...BASE, GITHUB_TOKEN: "ghp_x", I13_REVIEWER: "r" });
      expect(message).toMatch(/GITHUB_REPOSITORY: GitHub（I-13） の他の変数が設定されているため必須です/);
      expect(message).toMatch(/I13_ISSUE_NUMBER: /);
      expect(message).not.toMatch(/GITHUB_TOKEN: /);
    });

    it("空入力: グループの一部が空文字なら、その変数を未設定として必須に挙げる", () => {
      const { message } = failWith({ ...BASE, ...MISWRITE, MISWRITE_CHATWOOT_API_TOKEN: "" });
      expect(message).toMatch(/MISWRITE_CHATWOOT_API_TOKEN: 誤った書き込みの突き合わせ の他の変数が設定されているため必須です/);
    });

    it("入力: AWS_PROFILE だけの設定は設定漏れとして REGION と BUCKET を求める", () => {
      const { message } = failWith({ ...BASE, AWS_PROFILE: "comegin" });
      expect(message).toMatch(/AWS_REGION: AWS_PROFILE が設定されているため必須です/);
      expect(message).toMatch(/RUNLOG_BUCKET: AWS_PROFILE が設定されているため必須です/);
    });

    it.each([
      ["GITHUB_REPOSITORY", { ...GITHUB, GITHUB_REPOSITORY: "no-slash" }],
      ["I13_ISSUE_NUMBER", { ...GITHUB, I13_ISSUE_NUMBER: "0" }],
      ["MISWRITE_CHATWOOT_ACCOUNT_ID", { ...MISWRITE, MISWRITE_CHATWOOT_ACCOUNT_ID: "abc" }],
      ["MISWRITE_CHATWOOT_BASE_URL", { ...MISWRITE, MISWRITE_CHATWOOT_BASE_URL: "not a url" }],
    ])("入力: %s の形が不正なら ConfigError", (name, env) => {
      expect(failWith({ ...BASE, ...env }).message).toMatch(new RegExp(`${name}: `));
    });
  });
});

describe("loadControlPlaneConfig: n8n の書き出し（CONTROL_N8N_EXPORT_*）", () => {
  const N8N = { CONTROL_N8N_EXPORT_URL: "https://n8n.example.test/", CONTROL_N8N_EXPORT_API_KEY: "n8n_api_key_value" };

  describe("正常系", () => {
    it("URL と API キーがそろえば有効で、URL の末尾の / を落とす", () => {
      expect(loadControlPlaneConfig({ ...BASE, ...N8N }).n8nExport).toEqual({
        baseUrl: "https://n8n.example.test",
        apiKey: "n8n_api_key_value",
      });
    });

    it("パスつきの URL も末尾の / だけを落とす（複数でも）", () => {
      const config = loadControlPlaneConfig({ ...BASE, ...N8N, CONTROL_N8N_EXPORT_URL: "http://127.0.0.1:5679/n8n//" });
      expect(config.n8nExport?.baseUrl).toBe("http://127.0.0.1:5679/n8n");
    });

    it.each([
      ["URL だけ", { CONTROL_N8N_EXPORT_URL: N8N.CONTROL_N8N_EXPORT_URL }],
      ["API キーだけ", { CONTROL_N8N_EXPORT_API_KEY: N8N.CONTROL_N8N_EXPORT_API_KEY }],
    ])("%s の設定は例外にせず null にする（n8n-export は skipped。グループの検査をしない）", (_label, env) => {
      expect(loadControlPlaneConfig({ ...BASE, ...env }).n8nExport).toBeNull();
    });

    it("空入力: 両方が未設定・空文字・空白だけなら null", () => {
      expect(loadControlPlaneConfig(BASE).n8nExport).toBeNull();
      expect(loadControlPlaneConfig({ ...BASE, CONTROL_N8N_EXPORT_URL: "", CONTROL_N8N_EXPORT_API_KEY: "" }).n8nExport).toBeNull();
      expect(loadControlPlaneConfig({ ...BASE, CONTROL_N8N_EXPORT_URL: " ", CONTROL_N8N_EXPORT_API_KEY: " " }).n8nExport).toBeNull();
    });

    it("空入力: API キーが空文字なら、URL があっても null", () => {
      expect(loadControlPlaneConfig({ ...BASE, ...N8N, CONTROL_N8N_EXPORT_API_KEY: "" }).n8nExport).toBeNull();
    });

    it("n8n の設定は GitHub のグループと独立している（GitHub が無くても n8nExport は有効）", () => {
      const config = loadControlPlaneConfig({ ...BASE, ...N8N });
      expect(config.github).toBeNull();
      expect(config.n8nExport).not.toBeNull();
    });
  });

  describe("異常系", () => {
    it.each(["n8n.example.test", "not a url", "/api/v1"])("入力: CONTROL_N8N_EXPORT_URL が URL の形でない（%s）なら ConfigError", (url) => {
      expect(failWith({ ...BASE, ...N8N, CONTROL_N8N_EXPORT_URL: url }).message).toMatch(/CONTROL_N8N_EXPORT_URL: /);
    });

    it("入力: API キーが無くても、URL の形が不正なら ConfigError（片方だけの扱いより形の検査が先）", () => {
      expect(failWith({ ...BASE, CONTROL_N8N_EXPORT_URL: "not a url" }).message).toMatch(/CONTROL_N8N_EXPORT_URL: /);
    });

    it("入力: 不正な URL と API キーの値は、例外にもログにも出さない", () => {
      const { message, logged } = failWith({
        ...BASE,
        CONTROL_N8N_EXPORT_URL: "secret-n8n-host-without-scheme",
        CONTROL_N8N_EXPORT_API_KEY: "n8n_SUPERSECRET_KEY_123",
      });
      for (const value of ["secret-n8n-host-without-scheme", "n8n_SUPERSECRET_KEY_123"]) {
        expect(message).not.toContain(value);
        expect(logged).not.toContain(value);
      }
    });
  });
});

describe("loadControlPlaneConfig: エラーの出し方", () => {
  describe("異常系", () => {
    it("入力: 変数名と理由だけを stderr に出し、値（秘密値を含む）は例外にもログにも出さない", () => {
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

    it("空入力: 環境変数が 1 つも無くても process.exit を呼ばずに例外で返す（ライブラリなので）", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit が呼ばれた");
      });
      expect(() => loadControlPlaneConfig({})).toThrow(ConfigError);
      expect(exit).not.toHaveBeenCalled();
    });
  });
});
