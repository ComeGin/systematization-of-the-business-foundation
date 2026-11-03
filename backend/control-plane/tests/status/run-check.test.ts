import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 子プロセス（設定スクリプト）は差し替える。実際には起動しない
type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { runSetupCheck, type StatusConfig } from "../../src/status/run-check.js";

const STATUS: StatusConfig = {
  awsCredentialsFile: "/home/u/.config/comegin/status-reader/aws-credentials",
  awsProfile: "default",
  githubTokenFile: "/home/u/.config/comegin/status-reader/github-token",
  alertTopicArn: "arn:aws:sns:ap-northeast-1:123456789012:comegin-ops-alert",
  linkBase: "http://127.0.0.1:3200",
  region: "ap-northeast-1",
  repository: "ComeGin/systematization-of-the-business-foundation",
  siteUrl: "https://www.example.test",
};

const report = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  target: "prod",
  script: "setup/setup.mjs",
  startedAt: "2026-11-03T10:00:00.000+09:00",
  finishedAt: "2026-11-03T10:01:00.000+09:00",
  results: [
    {
      moduleId: "cloud",
      phase: "env",
      ok: true,
      notes: ["道具がそろっている"],
      items: [{ key: "cloud.sns-subscription", step: "P2", level: "warn", title: "SNS", evidence: "購読が 1 つ" }],
      error: null,
      skipped: false,
    },
  ],
  ...overrides,
});

function respond(result: { error?: Error & Record<string, unknown>; stdout?: string; stderr?: string }) {
  execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Callback) => {
    callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
    return {};
  });
}

const run = (overrides: Partial<Parameters<typeof runSetupCheck>[0]> = {}) =>
  runSetupCheck({
    mainCheckout: "/srv/main",
    worktree: "/home/u/work",
    status: STATUS,
    script: "setup/setup.mjs",
    skip: [],
    signal: new AbortController().signal,
    ...overrides,
  });

beforeEach(() => {
  execFileMock.mockReset();
  vi.stubEnv("PATH", "/usr/bin");
  vi.stubEnv("HOME", "/home/u");
  vi.stubEnv("GITHUB_TOKEN", "should-not-pass");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "should-not-pass");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("runSetupCheck", () => {
  describe("正常系", () => {
    it("入力: 読み取りの引数（--check --json --phase all）とチェックアウトの cwd で起動する", async () => {
      respond({ stdout: `${JSON.stringify(report())}\n` });
      await run({ skip: ["chatwoot-prod", "mautic-prod"] });
      const [file, args, options] = execFileMock.mock.calls[0]!;
      expect(file).toBe(process.execPath);
      expect(args).toEqual([
        "/srv/main/setup/setup.mjs",
        "--target",
        "prod",
        "--check",
        "--json",
        "--phase",
        "all",
        "--skip",
        "chatwoot-prod,mautic-prod",
      ]);
      expect(options).toMatchObject({ cwd: "/srv/main", timeout: 5 * 60 * 1000, killSignal: "SIGKILL" });
    });

    it("入力: 飛ばすものが無ければ --skip を付けない", async () => {
      respond({ stdout: JSON.stringify(report()) });
      await run();
      expect(execFileMock.mock.calls[0]![1]).not.toContain("--skip");
    });

    it("入力: env は許可リストだけ（AWS_CONFIG_FILE=/dev/null・SETUP_WORKTREE。GitHub のトークンは渡さない）", async () => {
      respond({ stdout: JSON.stringify(report()) });
      await run();
      const env = (execFileMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env;
      expect(env).toEqual({
        PATH: "/usr/bin",
        HOME: "/home/u",
        ...(process.env.LANG !== undefined ? { LANG: process.env.LANG } : {}),
        AWS_SHARED_CREDENTIALS_FILE: STATUS.awsCredentialsFile,
        AWS_PROFILE: "default",
        AWS_REGION: "ap-northeast-1",
        AWS_CONFIG_FILE: "/dev/null",
        SETUP_WORKTREE: "/home/u/work",
      });
    });

    it("入力: 標準出力の最後の空でない行を結果として読む", async () => {
      respond({ stdout: `前の行\n${JSON.stringify(report())}\n\n` });
      const result = await run();
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.results[0]!.items[0]).toEqual({
        key: "cloud.sns-subscription",
        step: "P2",
        level: "warn",
        title: "SNS",
        evidence: "購読が 1 つ",
      });
    });

    it("入力: 知らない level の項目は unknown にし、報告全体は捨てない", async () => {
      const bad = report();
      (bad.results[0]!.items as unknown[]) = [
        { key: "cloud.dmarc", step: "P4", level: "bad", title: "DMARC", evidence: "x" },
        { step: "P4", level: "ok" },
      ];
      respond({ stdout: JSON.stringify(bad) });
      const result = await run();
      if ("error" in result) throw new Error(result.error);
      expect(result.results[0]!.items).toHaveLength(1);
      expect(result.results[0]!.items[0]).toMatchObject({ key: "cloud.dmarc", level: "unknown" });
    });

    it("入力: 終了コードが 0 以外でも結果の JSON があれば使う", async () => {
      respond({ error: Object.assign(new Error("failed"), { code: 1 }), stdout: JSON.stringify(report()) });
      const result = await run();
      expect("error" in result).toBe(false);
    });
  });

  describe("異常系", () => {
    it("サーバ: 5 分で終わらず殺されたら、その旨を返す（標準エラーは返さない）", async () => {
      respond({ error: Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" }), stderr: "secret-in-stderr" });
      const result = await run({ redact: (t) => t.replace("secret-in-stderr", "[伏せ字]") });
      expect(result).toEqual({ error: "setup/setup.mjs の確認が 300 秒で終わらなかった" });
      const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("secret-in-stderr");
    });

    it("サーバ: 終了コードが 0 以外で JSON も無ければ、終了コードだけを返す", async () => {
      respond({ error: Object.assign(new Error("failed"), { code: 1 }), stdout: "", stderr: "✗ 何か" });
      expect(await run()).toEqual({ error: "setup/setup.mjs の確認が失敗した（終了コード 1）" });
    });

    it("空入力: 標準出力が空なら、結果が無いと返す", async () => {
      respond({ stdout: "\n" });
      expect(await run()).toEqual({ error: "setup/setup.mjs が結果の JSON を出さなかった" });
    });

    it("入力: 最後の行が JSON でなければ、読めないと返す", async () => {
      respond({ stdout: "not json" });
      expect(await run()).toEqual({ error: "setup/setup.mjs の結果が JSON として読めない" });
    });

    it("入力: 版や形が違えば、場所だけを返す（値は出さない）", async () => {
      respond({ stdout: JSON.stringify(report({ version: 2 })) });
      const result = await run();
      expect(result).toEqual({ error: expect.stringContaining("の結果の形が不正（version") });
    });

    it("入力: 別のスクリプトの結果なら不正とする", async () => {
      respond({ stdout: JSON.stringify(report({ script: "setup/frontend.mjs" })) });
      expect(await run()).toEqual({ error: expect.stringContaining("script が setup/frontend.mjs") });
    });

    it("入力: 打ち切られた signal なら起動しない", async () => {
      const controller = new AbortController();
      controller.abort();
      expect(await run({ signal: controller.signal })).toEqual({ error: "打ち切られた" });
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });
});
