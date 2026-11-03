// frontend/next-js/setup/prod/index.mjs（モジュール next-js-prod）の、設定の状況（/setup-status）まわりの単体テスト。
//   - statusPrincipalProblem（止まる id next-js-prod:status-principal）: IAM ユーザー・付いているポリシー・資格情報ファイルのキーの主体
//   - statusGithubProblem（止まる id next-js-prod:status-github）: fine-grained PAT で読めること（Read-only かは機械で確かめられない）
//   - statusOriginWarning: origin の名前が設定のリポジトリと違う（改名前など）ときの警告（止めない）
//   - prodValues: チェックアウトの環境変数ファイルに書く設定の状況の 6 変数
//   - check: items の key（next-js-prod.status-principal・next-js-prod.status-github。どちらも P14）
// AWS（子プロセスの aws）と HTTP（GitHub）は偽物に差し替える。ファイルは一時ディレクトリだけに置く。
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeCtx, itemsByKey } from "../helpers/fake-ctx.mjs";
import { makeTempDir, removeTempDir } from "../helpers/temp-home.mjs";
import { check, prodValues, statusGithubProblem, statusOriginWarning, statusPrincipalProblem } from "../../../frontend/next-js/setup/prod/index.mjs";

const USER = "comegin-prod-status-reader";
const GOOD_ARN = `arn:aws:iam::123456789012:user/${USER}`;
const SECRET = "github_pat_dummy_status_token_0123456789";

let dir;
beforeEach(() => {
  dir = makeTempDir("comegin-status-prod-");
});
afterEach(() => removeTempDir(dir));

function writeSecretFile(name, content, mode = 0o600) {
  const file = join(dir, name);
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}
const credentialsFile = (mode, content = `[default]\naws_access_key_id = AKIAXXXX\naws_secret_access_key = dummy\n`) => writeSecretFile("aws-credentials", content, mode);

/** aws の呼び出しを偽物にする。handlers は "iam get-user" のような先頭 2 語 → 返す JSON の文字列か、Error（投げる） */
function awsCtx(handlers, extra = {}) {
  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    const h = handlers[`${args[0]} ${args[1]}`];
    if (h === undefined) throw new Error(`想定外の呼び出し: ${cmd} ${args.join(" ")}`);
    if (h instanceof Error) throw h;
    return h;
  };
  return { ctx: fakeCtx({ overrides: { run, ...extra } }), calls };
}
const okIam = {
  "iam get-user": JSON.stringify({ User: { UserName: USER } }),
  "iam list-attached-user-policies": JSON.stringify({ AttachedPolicies: [{ PolicyName: USER }] }),
  "sts get-caller-identity": JSON.stringify({ Arn: GOOD_ARN }),
};

describe("statusPrincipalProblem（next-js-prod:status-principal）", () => {
  describe("正常系", () => {
    it("入力: ユーザーがあり、ポリシーが comegin-prod-status-reader だけで、キーの主体がそのユーザーなら問題なし", async () => {
      const { ctx } = awsCtx(okIam);
      expect(await statusPrincipalProblem(ctx, credentialsFile(0o600))).toBeNull();
    });

    it("入力: キーの確認は、管理者の環境変数を引き継がない子プロセスで、資格情報ファイルとプロファイル default だけで行う", async () => {
      const file = credentialsFile(0o600);
      const { ctx, calls } = awsCtx(okIam);
      await statusPrincipalProblem(ctx, file);
      const sts = calls.find((c) => c.args[0] === "sts");
      expect(sts.opts.inheritEnv).toBe(false);
      expect(sts.opts.env).toMatchObject({ AWS_SHARED_CREDENTIALS_FILE: file, AWS_PROFILE: "default", AWS_CONFIG_FILE: "/dev/null" });
      // IAM の読み取りは環境の主体（inheritEnv を指定しない）
      expect(calls.filter((c) => c.args[0] === "iam").every((c) => c.opts.inheritEnv === undefined)).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: IAM ユーザーが無いと、ユーザーが無いと返す（ファイルは見ない）", async () => {
      const { ctx } = awsCtx({ ...okIam, "iam get-user": new Error("An error occurred (NoSuchEntity) when calling the GetUser operation") });
      expect(await statusPrincipalProblem(ctx, credentialsFile(0o600))).toContain(`IAM ユーザー ${USER} が無い`);
    });

    it("入力: 管理ポリシーが付いていないと問題", async () => {
      const { ctx } = awsCtx({ ...okIam, "iam list-attached-user-policies": JSON.stringify({ AttachedPolicies: [] }) });
      expect(await statusPrincipalProblem(ctx, credentialsFile(0o600))).toContain("管理ポリシー comegin-prod-status-reader が付いていない");
    });

    it("入力: ほかのポリシーも付いている（comegin-prod-control-plane など）と、その名前を挙げて問題", async () => {
      const { ctx } = awsCtx({ ...okIam, "iam list-attached-user-policies": JSON.stringify({ AttachedPolicies: [{ PolicyName: USER }, { PolicyName: "comegin-prod-control-plane" }] }) });
      const p = await statusPrincipalProblem(ctx, credentialsFile(0o600));
      expect(p).toContain("以外のポリシー");
      expect(p).toContain("comegin-prod-control-plane");
    });

    it("入力: キーの主体が別のユーザー（comegin-prod-control-plane）だと問題（ARN を示す）", async () => {
      const { ctx } = awsCtx({ ...okIam, "sts get-caller-identity": JSON.stringify({ Arn: "arn:aws:iam::123456789012:user/comegin-prod-control-plane" }) });
      const p = await statusPrincipalProblem(ctx, credentialsFile(0o600));
      expect(p).toContain("のものではない");
      expect(p).toContain("user/comegin-prod-control-plane");
    });

    it("サーバ: キーで認証できない（InvalidClientTokenId）と、認証できないという問題（例外にしない）", async () => {
      const { ctx } = awsCtx({ ...okIam, "sts get-caller-identity": new Error("aws: An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation") });
      expect(await statusPrincipalProblem(ctx, credentialsFile(0o600))).toContain("で認証できない");
    });

    it("サーバ: IAM を読めない（AccessDenied）ときは例外（呼び出し側が「確かめられなかった」にする）", async () => {
      const { ctx } = awsCtx({ ...okIam, "iam get-user": new Error("An error occurred (AccessDenied) when calling the GetUser operation") });
      await expect(statusPrincipalProblem(ctx, credentialsFile(0o600))).rejects.toThrow("AccessDenied");
    });

    it("空入力: 資格情報ファイルが無いと問題", async () => {
      const { ctx } = awsCtx(okIam);
      expect(await statusPrincipalProblem(ctx, join(dir, "nothing"))).toContain("資格情報ファイル");
    });

    it("入力: 資格情報ファイルがほかのユーザーにも読める（644）と問題。STS は呼ばない", async () => {
      const { ctx, calls } = awsCtx(okIam);
      expect(await statusPrincipalProblem(ctx, credentialsFile(0o644))).toContain("chmod 600");
      expect(calls.some((c) => c.args[0] === "sts")).toBe(false);
    });

    it("入力: 資格情報ファイルに節 [default] が無いと問題", async () => {
      const { ctx } = awsCtx(okIam);
      expect(await statusPrincipalProblem(ctx, credentialsFile(0o600, "[other]\naws_access_key_id = x\n"))).toContain("[default]");
    });
  });
});

describe("statusGithubProblem（next-js-prod:status-github）", () => {
  // 読み取り専用（Read-only）かは機械で確かめられない（GET /repos の permissions は認証ユーザーの役割で、トークンの範囲ではない）。
  // 確かめるのは: 600・空でない・fine-grained（github_pat_）・200・X-OAuth-Scopes が付かない
  const response = (status, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => ({ permissions: { admin: true, push: true, pull: true } }), // 所有者の応答。見ない
  });
  function githubCtx(res, conf = {}) {
    const calls = [];
    const http = async (label, url, opts) => {
      calls.push({ label, url, opts });
      if (res instanceof Error) throw res;
      return res;
    };
    return { ctx: fakeCtx({ conf, overrides: { http } }), calls };
  }
  const tokenFile = (mode = 0o600, content = `${SECRET}\n`) => writeSecretFile("github-token", content, mode);

  describe("正常系", () => {
    it("入力: github_pat_ のトークンで 200・X-OAuth-Scopes なしなら問題なし（応答の permissions.push が true でも通す）", async () => {
      const { ctx } = githubCtx(response(200));
      expect(await statusGithubProblem(ctx, tokenFile())).toBeNull();
    });

    it("入力: X-OAuth-Scopes が空の文字列でも、中身が無いので通す", async () => {
      const { ctx } = githubCtx(response(200, { "x-oauth-scopes": "" }));
      expect(await statusGithubProblem(ctx, tokenFile())).toBeNull();
    });

    it("入力: リポジトリは GITHUB_REPOSITORY（prod.conf）、無ければ ComeGin/systematization-of-the-business-foundation。Bearer で渡し、書き込みはしない（GET）", async () => {
      const a = githubCtx(response(200));
      await statusGithubProblem(a.ctx, tokenFile());
      expect(a.calls[0].url).toBe("https://api.github.com/repos/ComeGin/systematization-of-the-business-foundation");
      expect(a.calls[0].opts.headers.Authorization).toBe(`Bearer ${SECRET}`);
      expect(a.calls[0].opts.method).toBeUndefined();
      const b = githubCtx(response(200), { GITHUB_REPOSITORY: "Org/other" });
      await statusGithubProblem(b.ctx, tokenFile());
      expect(b.calls[0].url).toBe("https://api.github.com/repos/Org/other");
    });
  });

  describe("異常系", () => {
    it.each(["ghp_classictoken0123456789", "gho_oauthtoken0123456789", "ghs_servertoken0123456789", "abcdef"])(
      "入力: classic などのトークン（%s）は fine-grained ではないと拒否し、fine-grained PAT（Contents・Pull requests の Read-only）を案内する。HTTP は呼ばない",
      async (token) => {
        const { ctx, calls } = githubCtx(response(200));
        const p = await statusGithubProblem(ctx, tokenFile(0o600, `${token}\n`));
        expect(p).toContain("fine-grained");
        expect(p).toContain("Contents: Read-only");
        expect(p).toContain("Pull requests: Read-only");
        expect(p).not.toContain(token);
        expect(calls).toHaveLength(0);
      },
    );

    it("サーバ: 200 でも X-OAuth-Scopes に中身があると（classic の印）問題。トークンの値は含めない", async () => {
      const { ctx } = githubCtx(response(200, { "x-oauth-scopes": "repo, workflow" }));
      const p = await statusGithubProblem(ctx, tokenFile());
      expect(p).toContain("X-OAuth-Scopes");
      expect(p).not.toContain(SECRET);
    });

    it("サーバ: 401（期限切れ・失効）は問題。ステータスとヒントを含み、トークンの値は含めない", async () => {
      const { ctx } = githubCtx(response(401));
      const p = await statusGithubProblem(ctx, tokenFile());
      expect(p).toContain("HTTP 401");
      expect(p).toContain("期限切れ");
      expect(p).not.toContain(SECRET);
    });

    it("サーバ: 403・404（対象のリポジトリが違う・権限なし）も問題", async () => {
      for (const status of [403, 404]) {
        const { ctx } = githubCtx(response(status));
        expect(await statusGithubProblem(ctx, tokenFile())).toContain(`HTTP ${status}`);
      }
    });

    it("サーバ: 503 は例外（確かめられなかった扱い）", async () => {
      const { ctx } = githubCtx(response(503));
      await expect(statusGithubProblem(ctx, tokenFile())).rejects.toThrow("HTTP 503");
    });

    it("サーバ: GitHub に接続できないときは例外（確かめられなかった扱い）", async () => {
      const { ctx } = githubCtx(Object.assign(new Error("GitHub: https://api.github.com に接続できない（ENOTFOUND）"), { status: 0 }));
      await expect(statusGithubProblem(ctx, tokenFile())).rejects.toThrow("接続できない");
    });

    it("空入力: トークンのファイルが無いと問題。HTTP は呼ばない", async () => {
      const { ctx, calls } = githubCtx(response(200));
      expect(await statusGithubProblem(ctx, join(dir, "nothing"))).toContain("が無い");
      expect(calls).toHaveLength(0);
    });

    it("空入力: トークンのファイルが空（改行だけ）だと問題。HTTP は呼ばない", async () => {
      const { ctx, calls } = githubCtx(response(200));
      expect(await statusGithubProblem(ctx, tokenFile(0o600, "\n"))).toContain("空");
      expect(calls).toHaveLength(0);
    });

    it("入力: トークンのファイルが 600 でない（644・640）と問題。HTTP は呼ばない", async () => {
      for (const mode of [0o644, 0o640]) {
        const { ctx, calls } = githubCtx(response(200));
        expect(await statusGithubProblem(ctx, tokenFile(mode))).toContain("chmod 600");
        expect(calls).toHaveLength(0);
      }
    });
  });
});

describe("statusOriginWarning（origin の名前の警告。止めない）", () => {
  const OLD = "https://github.com/kamegin4-aws/systematization-of-the-business-foundation.git";
  function originCtx(origin, conf = {}) {
    const calls = [];
    const run = async (cmd, args) => {
      calls.push({ cmd, args });
      if (origin instanceof Error) throw origin;
      return `${origin}\n`;
    };
    return { ctx: fakeCtx({ conf, overrides: { run } }), calls };
  }

  describe("正常系", () => {
    it("入力: origin が設定のリポジトリと同じ（大文字・小文字、.git の有無は問わない）なら null", async () => {
      for (const url of [
        "https://github.com/ComeGin/systematization-of-the-business-foundation.git",
        "https://github.com/comegin/systematization-of-the-business-foundation",
        "git@github.com:ComeGin/systematization-of-the-business-foundation.git",
      ]) {
        expect(await statusOriginWarning(originCtx(url).ctx)).toBeNull();
      }
    });

    it("入力: origin が改名前の名前なら、git remote set-url の直し方を含む警告を返す（読むのは作業ツリーの origin）", async () => {
      const { ctx, calls } = originCtx(OLD);
      const warning = await statusOriginWarning(ctx);
      expect(warning).toContain("origin が kamegin4-aws/systematization-of-the-business-foundation を指している");
      expect(warning).toContain("git -C <作業ツリー> remote set-url origin https://github.com/ComeGin/systematization-of-the-business-foundation.git");
      expect(calls[0]).toEqual({ cmd: "git", args: ["-C", "/nonexistent/WORKTREE", "remote", "get-url", "origin"] });
    });

    it("入力: 比べる相手は prod.conf の GITHUB_REPOSITORY（あれば）", async () => {
      expect(await statusOriginWarning(originCtx("https://github.com/Org/other.git", { GITHUB_REPOSITORY: "Org/other" }).ctx)).toBeNull();
      expect(await statusOriginWarning(originCtx(OLD, { GITHUB_REPOSITORY: "Org/other" }).ctx)).toContain("https://github.com/Org/other.git");
    });
  });

  describe("異常系", () => {
    it("入力: origin を読めない・GitHub の URL でないときは何も言わない（null）", async () => {
      expect(await statusOriginWarning(originCtx(new Error("No such remote 'origin'")).ctx)).toBeNull();
      expect(await statusOriginWarning(originCtx("https://example.test/a/b.git").ctx)).toBeNull();
    });
  });
});

describe("prodValues（チェックアウトの環境変数ファイルに書く設定の状況の変数）", () => {
  const stackOutputs = (extra = []) =>
    JSON.stringify({
      Stacks: [{ Outputs: [{ OutputKey: "RunLogBucketName", OutputValue: "runlog-bucket" }, { OutputKey: "OpsAlertTopicArn", OutputValue: "arn:aws:sns:ap-northeast-1:123456789012:comegin-ops-alert" }, ...extra] }],
    });
  const baseConf = () => ({
    ADMIN_EMAIL: "admin@comegin.com",
    CONTROL_GOOGLE_CLIENT_ID: "id",
    CONTROL_GOOGLE_CLIENT_SECRET: "secret",
    ANTHROPIC_API_KEY: "sk-dummy",
    PUBLIC_SITE_URL: "https://comegin.com",
    CHATWOOT_ACCOUNT_ID: "1",
    CHATWOOT_AGENT_TOKEN: "agent-token",
  });
  const valuesCtx = (conf, describeStacks = stackOutputs()) =>
    fakeCtx({
      conf: { ...baseConf(), ...conf },
      stateValues: { CHATWOOT_AGENT_USER_ID: "7" },
      overrides: { WORKTREE: join(dir, "worktree"), run: async (cmd, args) => (args[0] === "cloudformation" ? describeStacks : Promise.reject(new Error(`想定外: ${cmd} ${args.join(" ")}`))) },
    });
  const main = "/srv/checkout";
  const file = "/home/u/.config/comegin/control-plane/aws-credentials";

  describe("正常系", () => {
    it("入力: 6 変数が、既定の置き場・default・スタックの出力 OpsAlertTopicArn・開く URL と同じリンクの根で書かれる", async () => {
      const { values, missing } = await prodValues(valuesCtx({ CONTROL_PUBLIC_URL: "http://127.0.0.1:3200" }), main, file);
      expect(missing).toEqual([]);
      expect(values).toMatchObject({
        CONTROL_SETUP_STATUS_ENABLED: "true",
        CONTROL_STATUS_AWS_PROFILE: "default",
        CONTROL_STATUS_ALERT_TOPIC_ARN: "arn:aws:sns:ap-northeast-1:123456789012:comegin-ops-alert",
        CONTROL_STATUS_LINK_BASE: "http://127.0.0.1:3200",
      });
      expect(values.CONTROL_STATUS_AWS_CREDENTIALS_FILE).toMatch(/^\/.+\/\.config\/comegin\/status-reader\/aws-credentials$/);
      expect(values.CONTROL_STATUS_GITHUB_TOKEN_FILE).toMatch(/^\/.+\/\.config\/comegin\/status-reader\/github-token$/);
      expect(values.CONTROL_STATUS_LINK_BASE).toBe(values.BETTER_AUTH_URL);
    });

    it("入力: CONTROL_PUBLIC_URL の末尾のスラッシュは落とし、BETTER_AUTH_URL と CONTROL_STATUS_LINK_BASE が同じ値になる", async () => {
      const { values } = await prodValues(valuesCtx({ CONTROL_PUBLIC_URL: "http://127.0.0.1:3200/" }), main, file);
      expect(values.BETTER_AUTH_URL).toBe("http://127.0.0.1:3200");
      expect(values.CONTROL_STATUS_LINK_BASE).toBe("http://127.0.0.1:3200");
    });

    it("入力: 置き場は prod.conf の CONTROL_STATUS_*_FILE で変えられる。秘密の値そのものは values に入らない", async () => {
      const { values } = await prodValues(valuesCtx({ CONTROL_STATUS_AWS_CREDENTIALS_FILE: "/x/aws", CONTROL_STATUS_GITHUB_TOKEN_FILE: "/x/gh" }), main, file);
      expect(values.CONTROL_STATUS_AWS_CREDENTIALS_FILE).toBe("/x/aws");
      expect(values.CONTROL_STATUS_GITHUB_TOKEN_FILE).toBe("/x/gh");
      expect(JSON.stringify(values)).not.toContain(SECRET);
    });
  });

  describe("異常系", () => {
    it("サーバ: スタックの出力に OpsAlertTopicArn が無いと、足りないものとして OpsAlertTopicArn を挙げる", async () => {
      const noTopic = JSON.stringify({ Stacks: [{ Outputs: [{ OutputKey: "RunLogBucketName", OutputValue: "runlog-bucket" }] }] });
      const { missing } = await prodValues(valuesCtx({}, noTopic), main, file);
      expect(missing.some((m) => m.includes("OpsAlertTopicArn"))).toBe(true);
    });
  });
});

describe("check の items（設定の状況の 2 つ）", () => {
  describe("正常系", () => {
    it("入力: チェックアウトが決まらないときも、2 つの key が P14 の unknown で返る（stopId は付かない）", async () => {
      const r = await check(fakeCtx({ conf: {}, overrides: { phase: "operate" } }));
      const items = itemsByKey(r);
      for (const key of ["next-js-prod.status-principal", "next-js-prod.status-github"]) {
        expect(items[key]).toMatchObject({ step: "P14", level: "unknown" });
        expect(items[key].stopId).toBeUndefined();
      }
    });
  });
});

describe("check の items（チェックアウトが決まったとき）", () => {
  /** チェックアウトの体裁だけ整え、git と aws を偽物にする。status-reader のユーザーは無い、トークンのファイルも無い状態 */
  function fullCtx(awsHandlers, { origin = "1000", githubTokenFile = join(dir, "nope-gh"), http } = {}) {
    const checkout = join(dir, "checkout");
    mkdirSync(join(checkout, "frontend/next-js"), { recursive: true });
    writeFileSync(join(checkout, "frontend/next-js/package.json"), "{}");
    const run = async (cmd, args) => {
      if (cmd === "git" && args.includes("get-url")) return `${origin}\n`;
      if (cmd === "git") return args.includes("rev-parse") ? "abcdef1234567890\n" : "1000\n";
      if (cmd === "systemctl") throw new Error("ユニットが無い（偽）");
      if (cmd === "aws") {
        const h = awsHandlers[`${args[0]} ${args[1]}`];
        if (h instanceof Error) throw h;
        if (h !== undefined) return h;
      }
      throw new Error(`想定外の呼び出し: ${cmd} ${args.join(" ")}`);
    };
    return fakeCtx({
      conf: { CONTROL_MAIN_CHECKOUT: checkout, CONTROL_STATUS_AWS_CREDENTIALS_FILE: join(dir, "nope-aws"), CONTROL_STATUS_GITHUB_TOKEN_FILE: githubTokenFile },
      overrides: { phase: "operate", WORKTREE: join(dir, "worktree"), run, ...(http ? { http } : {}) },
    });
  }
  const iamMissing = { "iam get-user": new Error("NoSuchEntity") };

  describe("異常系", () => {
    it("入力: 主体もトークンのファイルも無いと、2 つの key が action で、止まる id が status-principal・status-github", async () => {
      mkdirSync(join(dir, "worktree"), { recursive: true });
      const r = await check(fullCtx({ ...iamMissing, "cloudformation describe-stacks": "{}", "cloudwatch describe-alarms": "{}" }));
      const items = itemsByKey(r);
      expect(items["next-js-prod.status-principal"]).toMatchObject({ step: "P14", level: "action", stopId: "next-js-prod:status-principal" });
      expect(items["next-js-prod.status-github"]).toMatchObject({ step: "P14", level: "action", stopId: "next-js-prod:status-github" });
      expect(r.ok).toBe(false);
    });

    it("入力: トークンは良いが origin が改名前の名前なら、status-github は warn（止めない）で、notes に ! の行", async () => {
      mkdirSync(join(dir, "worktree"), { recursive: true });
      const token = writeSecretFile("github-token", `${SECRET}\n`);
      const http = async () => ({ status: 200, ok: true, headers: new Headers(), json: async () => ({}) });
      const r = await check(
        fullCtx(
          { ...iamMissing, "cloudformation describe-stacks": "{}", "cloudwatch describe-alarms": "{}" },
          { origin: "https://github.com/kamegin4-aws/systematization-of-the-business-foundation.git", githubTokenFile: token, http },
        ),
      );
      const item = itemsByKey(r)["next-js-prod.status-github"];
      expect(item).toMatchObject({ step: "P14", level: "warn" });
      expect(item.stopId).toBeUndefined();
      expect(item.evidence).toContain("remote set-url origin https://github.com/ComeGin/systematization-of-the-business-foundation.git");
      expect(r.notes.some((n) => n.startsWith("! origin が kamegin4-aws/"))).toBe(true);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it("入力: トークンの問題があるときは action のまま、根拠に origin の警告も足す", async () => {
      mkdirSync(join(dir, "worktree"), { recursive: true });
      const r = await check(
        fullCtx(
          { ...iamMissing, "cloudformation describe-stacks": "{}", "cloudwatch describe-alarms": "{}" },
          { origin: "https://github.com/kamegin4-aws/systematization-of-the-business-foundation.git" },
        ),
      );
      const item = itemsByKey(r)["next-js-prod.status-github"];
      expect(item).toMatchObject({ level: "action", stopId: "next-js-prod:status-github" });
      expect(item.evidence).toMatch(/が無い／origin が kamegin4-aws\//);
    });

    it("サーバ: IAM を読めない（AccessDenied）ときは status-principal が unknown（stopId なし）", async () => {
      mkdirSync(join(dir, "worktree"), { recursive: true });
      const r = await check(fullCtx({ "iam get-user": new Error("An error occurred (AccessDenied)"), "cloudformation describe-stacks": "{}", "cloudwatch describe-alarms": "{}" }));
      const item = itemsByKey(r)["next-js-prod.status-principal"];
      expect(item.level).toBe("unknown");
      expect(item.stopId).toBeUndefined();
    });
  });
});
