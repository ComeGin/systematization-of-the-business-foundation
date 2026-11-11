// cloud/setup/index.mjs の check が返す items（監視アプリの「設定の状況」が読む項目）と、追跡しないファイルの読み先（ctx.WORKTREE）の単体テスト。
// AWS（awsJson・describeStack・secretHasValue・dbInitDone）と DNS は偽物に差し替える。実際の AWS・ネットワーク・状態ファイルには触れない。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, itemsByKey, recordingConfirm } from "../helpers/fake-ctx.mjs";
import { makeTempDir, removeTempDir } from "../helpers/temp-home.mjs";

const aws = vi.hoisted(() => ({ responses: {}, main: null, global: null, secret: true }));
vi.mock("../../../cloud/setup/aws.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    awsJson: async (_ctx, args) => {
      const r = aws.responses[`${args[0]} ${args[1]}`];
      if (r instanceof Error) throw r;
      if (typeof r === "function") return r(args); // 引数（リポジトリ名など）で応答を変えたいとき
      return r === undefined ? null : r;
    },
    describeStack: async (_ctx, name) => (name === actual.GLOBAL_STACK ? aws.global : aws.main),
    requireMainStack: async () => {
      if (!aws.main) throw new Error("スタック comegin-prod が無い");
      return aws.main;
    },
    secretHasValue: async () => aws.secret,
    dbInitDone: async () => true,
  };
});
const dns = vi.hoisted(() => ({ txt: [["v=DMARC1; p=none"]] }));
vi.mock("node:dns/promises", () => ({
  resolveTxt: async () => {
    if (dns.txt instanceof Error) throw dns.txt;
    return dns.txt;
  },
}));

const { check, apply } = await import("../../../cloud/setup/index.mjs");

const MAIN_STACK = {
  StackStatus: "CREATE_COMPLETE",
  CreationTime: "2026-10-30T00:00:00Z",
  Outputs: [
    { OutputKey: "OpsAlertTopicArn", OutputValue: "arn:aws:sns:ap-northeast-1:111:comegin-ops-alert" },
    { OutputKey: "LeadAlertTopicArn", OutputValue: "arn:aws:sns:ap-northeast-1:111:comegin-lead-alert" },
    { OutputKey: "OnpremStrapiMediaUserName", OutputValue: "onprem-strapi-media" },
    { OutputKey: "OnpremN8nSnsUserName", OutputValue: "onprem-n8n-sns" },
  ],
  Parameters: [
    { ParameterKey: "DomainName", ParameterValue: "comegin.com" },
    { ParameterKey: "WireguardFixedAmiId", ParameterValue: "ami-0123" },
    { ParameterKey: "DeployedCommit", ParameterValue: "a".repeat(40) },
  ],
};

function healthyAws() {
  aws.main = structuredClone(MAIN_STACK);
  aws.global = {
    StackStatus: "CREATE_COMPLETE",
    Parameters: [
      { ParameterKey: "DistributionArn", ParameterValue: "arn:aws:cloudfront::111:distribution/X" },
      { ParameterKey: "DeployedCommit", ParameterValue: "a".repeat(40) },
    ],
  };
  aws.secret = true;
  aws.responses = {
    "sts get-caller-identity": { Account: "111", Arn: "arn:aws:iam::111:user/comegin-iam" },
    "sns list-subscriptions-by-topic": { Subscriptions: [{ SubscriptionArn: "arn:aws:sns:ap-northeast-1:111:t:abc", Protocol: "email" }] },
    "sns get-subscription-attributes": { Attributes: { ConfirmationWasAuthenticated: "true" } },
    "sesv2 get-account": { ProductionAccessEnabled: true },
    "sesv2 get-email-identity": { DkimAttributes: { Status: "SUCCESS" }, MailFromAttributes: { MailFromDomainStatus: "SUCCESS", MailFromDomain: "mail.comegin.com" } },
    "iam list-access-keys": { AccessKeyMetadata: [{ Status: "Active", CreateDate: "2026-10-01T00:00:00Z" }] },
    "iam list-entities-for-policy": { PolicyUsers: [{ UserName: "x" }], PolicyRoles: [], PolicyGroups: [] },
  };
  dns.txt = [["v=DMARC1; p=none"]];
}

const APPS_KEYS = ["cloud.global-second", "cloud.sns-subscription", "cloud.ses-production", "cloud.ses-domain", "cloud.dmarc", "cloud.wireguard-ami", "cloud.onprem-keys", "cloud.smtp-secrets", "cloud.deploy-principal"];
const OPERATE_KEYS = ["cloud.deploy-principal", "cloud.old-keys", "cloud.setup-only-values", "cloud.ses-production"];
const apps = (conf = {}) => fakeCtx({ conf: { AWS_ACCOUNT_ID: "111", ...conf }, overrides: { phase: "apps" } });
const operate = (conf = {}) => fakeCtx({ conf: { AWS_ACCOUNT_ID: "111", ...conf }, overrides: { phase: "operate" } });

beforeEach(() => {
  healthyAws();
});

describe("cloud の段階 apps の items", () => {
  describe("正常系", () => {
    it("入力: 何も問題が無いと、9 つの key がすべて level ok で返り、notes に ! の文は無い", async () => {
      const r = await check(apps());
      expect(r.ok).toBe(true);
      expect(r.items.map((i) => i.key)).toEqual(APPS_KEYS);
      expect(r.items.every((i) => i.level === "ok")).toBe(true);
      expect(r.notes.some((n) => n.startsWith("! "))).toBe(false);
    });

    it("入力: 各項目に step・title・evidence がある（P2・P4・P6・P12）", async () => {
      const by = itemsByKey(await check(apps()));
      expect(Object.fromEntries(Object.entries(by).map(([k, i]) => [k, i.step]))).toEqual({
        "cloud.global-second": "P2",
        "cloud.sns-subscription": "P2",
        "cloud.ses-production": "P12",
        "cloud.ses-domain": "P4",
        "cloud.dmarc": "P4",
        "cloud.wireguard-ami": "P6",
        "cloud.onprem-keys": "P6",
        "cloud.smtp-secrets": "P4",
        "cloud.deploy-principal": "P12",
      });
      for (const i of Object.values(by)) {
        expect(i.title.length).toBeGreaterThan(0);
        expect(i.evidence.length).toBeGreaterThan(0);
      }
    });

    it("入力: 警告が出ても notes の文は今までどおり先頭が ! で、items の evidence と同じ文になる", async () => {
      aws.responses["sesv2 get-account"] = { ProductionAccessEnabled: false };
      const r = await check(apps());
      const w = r.notes.filter((n) => n.startsWith("! "));
      expect(w).toHaveLength(1);
      expect(w[0]).toBe(`! ${itemsByKey(r)["cloud.ses-production"].evidence}`);
      expect(w[0]).toContain("サンドボックス");
    });
  });

  describe("異常系", () => {
    it("サーバ: SES がサンドボックスで DMARC・AMI・SMTP・配信用の主体が揃っていないと、対応する項目だけ warn になる", async () => {
      aws.responses["sesv2 get-account"] = { ProductionAccessEnabled: false };
      dns.txt = [];
      aws.main.Parameters = aws.main.Parameters.filter((p) => p.ParameterKey !== "WireguardFixedAmiId");
      aws.responses["iam list-entities-for-policy"] = { PolicyUsers: [], PolicyRoles: [], PolicyGroups: [] };
      const originalSecret = aws.secret;
      aws.secret = null; // Secret が無い
      const r = await check(apps());
      aws.secret = originalSecret;
      const by = itemsByKey(r);
      for (const k of ["cloud.ses-production", "cloud.dmarc", "cloud.wireguard-ami", "cloud.smtp-secrets", "cloud.deploy-principal"]) expect(by[k].level, k).toBe("warn");
      for (const k of ["cloud.global-second", "cloud.sns-subscription", "cloud.ses-domain", "cloud.onprem-keys"]) expect(by[k].level, k).toBe("ok");
      expect(by["cloud.dmarc"].evidence).toContain("DMARC の TXT が無い");
      expect(by["cloud.smtp-secrets"].evidence).toContain("SMTP_USERNAME");
      expect(r.ok).toBe(true); // 警告は止めない
    });

    it("サーバ: global の 2 回目が済んでいない（DistributionArn が空）と cloud.global-second が warn", async () => {
      aws.global = { StackStatus: "CREATE_COMPLETE", Parameters: [{ ParameterKey: "DistributionArn", ParameterValue: "" }] };
      expect(itemsByKey(await check(apps()))["cloud.global-second"]).toMatchObject({ level: "warn", step: "P2" });
    });

    it("サーバ: SNS を誰も購読していない・解除に認証が要らない購読は cloud.sns-subscription が warn", async () => {
      aws.responses["sns list-subscriptions-by-topic"] = { Subscriptions: [] };
      expect(itemsByKey(await check(apps()))["cloud.sns-subscription"].level).toBe("warn");
      aws.responses["sns list-subscriptions-by-topic"] = { Subscriptions: [{ SubscriptionArn: "arn:aws:sns:x", Protocol: "email" }] };
      aws.responses["sns get-subscription-attributes"] = { Attributes: { ConfirmationWasAuthenticated: "false" } };
      expect(itemsByKey(await check(apps()))["cloud.sns-subscription"].evidence).toContain("誰でも解除できる");
    });

    it("サーバ: SES の DKIM・MAIL FROM が SUCCESS でないと cloud.ses-domain が warn（ses-production は ok のまま）", async () => {
      aws.responses["sesv2 get-email-identity"] = { DkimAttributes: { Status: "PENDING" }, MailFromAttributes: { MailFromDomainStatus: "FAILED", MailFromDomain: "mail.comegin.com" } };
      const by = itemsByKey(await check(apps()));
      expect(by["cloud.ses-domain"].level).toBe("warn");
      expect(by["cloud.ses-domain"].evidence).toContain("PENDING");
      expect(by["cloud.ses-production"].level).toBe("ok");
    });

    it("サーバ: オンプレ用 IAM ユーザーに有効なキーが無いと cloud.onprem-keys が warn", async () => {
      aws.responses["iam list-access-keys"] = { AccessKeyMetadata: [{ Status: "Inactive", CreateDate: "2026-10-01T00:00:00Z" }] };
      expect(itemsByKey(await check(apps()))["cloud.onprem-keys"].level).toBe("warn");
    });

    it("サーバ: SES を読めない（権限など）と、2 つの SES の項目が unknown になり、notes に出る文は 1 つだけ", async () => {
      aws.responses["sesv2 get-account"] = new Error("AccessDenied: sesv2:GetAccount");
      const r = await check(apps());
      const by = itemsByKey(r);
      expect(by["cloud.ses-production"].level).toBe("unknown");
      expect(by["cloud.ses-domain"].level).toBe("unknown");
      expect(r.notes.filter((n) => n.includes("SESを確かめられない"))).toHaveLength(1);
    });

    it("サーバ: SES のドメイン ID だけ読めないと、ses-production は ok のまま ses-domain だけ unknown", async () => {
      aws.responses["sesv2 get-email-identity"] = new Error("Throttling");
      const by = itemsByKey(await check(apps()));
      expect(by["cloud.ses-production"].level).toBe("ok");
      expect(by["cloud.ses-domain"].level).toBe("unknown");
    });

    it("サーバ: DNS を引けない（ENODATA 以外）と cloud.dmarc が unknown で、ほかの項目は続く", async () => {
      dns.txt = Object.assign(new Error("ESERVFAIL"), { code: "ESERVFAIL" });
      const by = itemsByKey(await check(apps()));
      expect(by["cloud.dmarc"].level).toBe("unknown");
      expect(by["cloud.wireguard-ami"].level).toBe("ok");
    });

    it("サーバ: 厳しい DMARC の照合（aspf=s）は cloud.dmarc が warn", async () => {
      dns.txt = [["v=DMARC1; p=none; aspf=s"]];
      expect(itemsByKey(await check(apps()))["cloud.dmarc"].level).toBe("warn");
    });

    it("サーバ: 本番スタックが無いと items は返さず ok: false（今までどおり）", async () => {
      aws.main = null;
      const r = await check(apps());
      expect(r.ok).toBe(false);
      expect(r.items).toBeUndefined();
    });
  });
});

describe("cloud の段階 operate の items", () => {
  describe("正常系", () => {
    it("入力: 問題が無いと 4 つの key がすべて ok で、step は P15", async () => {
      const r = await check(operate());
      expect(r.items.map((i) => i.key)).toEqual(OPERATE_KEYS);
      expect(r.items.every((i) => i.level === "ok" && i.step === "P15")).toBe(true);
      expect(r.notes).toEqual(["運用開始の仕上げ（配信用の主体・キーの残り・prod.conf の初期設定用の値・SES）は済んでいる"]);
    });
  });

  describe("異常系", () => {
    it("サーバ: 有効なキーが 2 つ残っていると cloud.old-keys が warn で、notes にも同じ文が出る", async () => {
      aws.responses["iam list-access-keys"] = {
        AccessKeyMetadata: [
          { Status: "Active", CreateDate: "2026-09-01T00:00:00Z" },
          { Status: "Active", CreateDate: "2026-10-01T00:00:00Z" },
        ],
      };
      const r = await check(operate());
      const i = itemsByKey(r)["cloud.old-keys"];
      expect(i.level).toBe("warn");
      expect(r.notes).toContain(`! ${i.evidence.split("／")[0]}`);
      expect(r.ok).toBe(true);
    });

    it("入力: prod.conf に初期設定用の値が残っていると cloud.setup-only-values が warn（値は evidence に出ない）", async () => {
      const r = await check(operate({ CHATWOOT_ADMIN_TOKEN: "tok-secret-value-0123456789" }));
      const i = itemsByKey(r)["cloud.setup-only-values"];
      expect(i.level).toBe("warn");
      expect(i.evidence).toContain("CHATWOOT_ADMIN_TOKEN");
      expect(JSON.stringify(r)).not.toContain("tok-secret-value-0123456789");
    });

    it("サーバ: サンドボックスと配信用の主体なしは、段階 operate では step が P15", async () => {
      aws.responses["sesv2 get-account"] = { ProductionAccessEnabled: false };
      aws.responses["iam list-entities-for-policy"] = { PolicyUsers: [], PolicyRoles: [], PolicyGroups: [] };
      const by = itemsByKey(await check(operate()));
      expect(by["cloud.ses-production"]).toMatchObject({ level: "warn", step: "P15" });
      expect(by["cloud.deploy-principal"]).toMatchObject({ level: "warn", step: "P15" });
    });

    it("サーバ: IAM を読めない（権限）と cloud.old-keys が unknown で、ほかの項目は続く", async () => {
      aws.responses["iam list-access-keys"] = new Error("AccessDenied: iam:ListAccessKeys");
      const by = itemsByKey(await check(operate()));
      expect(by["cloud.old-keys"].level).toBe("unknown");
      expect(by["cloud.ses-production"].level).toBe("ok");
    });
  });
});

describe("cloud の samconfig の読み先", () => {
  let worktree;
  let codeDir;
  beforeEach(() => {
    worktree = makeTempDir("comegin-worktree-");
    codeDir = makeTempDir("comegin-code-");
    mkdirSync(join(worktree, "cloud"), { recursive: true });
    writeFileSync(join(worktree, "cloud/samconfig.toml"), 'parameter_overrides = [\n  "RunLogAdminPrincipalArns=arn:aws:iam::111:user/x",\n  "GoogleClientId=abc",\n  "AdminBootstrapEmails=a@example.com",\n]\n');
  });
  afterEach(() => {
    removeTempDir(worktree);
    removeTempDir(codeDir);
  });

  const envCtx = () =>
    fakeCtx({
      conf: { AWS_ACCOUNT_ID: "111" },
      overrides: {
        phase: "env",
        W: codeDir, // コードの置き場（チェックアウト）。ここには追跡しないファイルは無い
        REPO: codeDir,
        WORKTREE: worktree,
        commandExists: async () => true,
        run: async (cmd) => (cmd === "sam" ? "SAM CLI, version 1.160.0" : "11.0.0"),
      },
    });

  describe("正常系", () => {
    it("入力: コードの置き場（W）に無くても、作業ツリー（WORKTREE）の cloud/samconfig.toml を読んで必須の値がそろっていると判定する", async () => {
      aws.responses["sts get-caller-identity"] = { Account: "111", Arn: "arn:aws:iam::111:user/comegin-iam" };
      const r = await check(envCtx());
      expect(r.ok).toBe(true);
      expect(r.notes.at(-1)).toContain("必須の値はそろっている");
    });
  });

  describe("異常系", () => {
    it("入力: 作業ツリーに cloud/samconfig.toml が無いと「無い」で止まる（コードの置き場にあっても読まない）", async () => {
      const empty = makeTempDir("comegin-empty-");
      try {
        const ctx = envCtx();
        ctx.WORKTREE = empty;
        mkdirSync(join(codeDir, "cloud"), { recursive: true });
        writeFileSync(join(codeDir, "cloud/samconfig.toml"), 'parameter_overrides = [ "GoogleClientId=abc" ]\n');
        const r = await check(ctx);
        expect(r.ok).toBe(false);
        expect(r.notes.some((n) => n.includes("cloud/samconfig.toml が無い"))).toBe(true);
      } finally {
        removeTempDir(empty);
      }
    });
  });
});

// apply の「!」（2026-11-10）。削除の注意は ctx.warn（止めない）、それ以外は手順付きの ctx.confirm（yes で進む・それ以外は止まる）
describe("cloud の apply の「!」の振り分け", () => {
  const applyCtx = (phase, answer = "yes", conf = {}) => {
    const rec = recordingConfirm(answer);
    const ctx = fakeCtx({ conf: { AWS_ACCOUNT_ID: "111", ...conf }, overrides: { phase, ...rec.overrides } });
    return { ctx, rec };
  };

  describe("正常系", () => {
    it("入力: 段階 apps で何も問題が無いと、確認も削除の注意も出さずに終わる", async () => {
      const { ctx, rec } = applyCtx("apps");
      await apply(ctx);
      expect(rec.asked).toEqual([]);
      expect(rec.warned).toEqual([]);
    });

    it("入力: 段階 apps の SES のサンドボックスと DMARC の欠けは、詳しい手順を付けて 1 件ずつ確認し、yes なら最後まで進む", async () => {
      aws.responses["sesv2 get-account"] = { ProductionAccessEnabled: false };
      dns.txt = [];
      const { ctx, rec } = applyCtx("apps");
      await apply(ctx);
      expect(rec.asked.map((a) => a.id)).toEqual(["ses-production", "dmarc"]);
      const [ses, dmarc] = rec.asked;
      expect(ses.title).toContain("サンドボックス");
      // 配信の前は申請しない（審査で Web サイトを見る）ので、yes で進めてよいことを手順に書く
      expect(ses.steps[0]).toContain("まだ配信していないなら");
      expect(ses.steps.join("\n")).toContain("Request production access");
      expect(dmarc.steps.join("\n")).toContain('"v=DMARC1; p=none; rua=mailto:');
      expect(rec.warned).toEqual([]);
    });

    it("入力: 段階 apps の SNS の未購読は、トピックの ARN を埋めた subscribe と、認証付きの confirm-subscription の手順を出す", async () => {
      aws.responses["sns list-subscriptions-by-topic"] = { Subscriptions: [] };
      const { ctx, rec } = applyCtx("apps");
      await apply(ctx);
      const sns = rec.asked.filter((a) => a.id === "sns-subscription");
      expect(sns).toHaveLength(2);
      const steps = sns[0].steps.join("\n");
      expect(steps).toContain("aws sns subscribe --region ap-northeast-1 --topic-arn arn:aws:sns:ap-northeast-1:111:comegin-ops-alert");
      expect(steps).toContain("--authenticate-on-unsubscribe true");
    });

    it("入力: 段階 apps の SMTP の Secret の欠けは、USERNAME と PASSWORD で 2 回聞かず、製品ごとに 1 回ずつ聞く", async () => {
      aws.secret = false;
      const { ctx, rec } = applyCtx("apps");
      await apply(ctx);
      const smtp = rec.asked.filter((a) => a.id === "smtp-secrets");
      expect(smtp.map((a) => a.title.split(" ")[0])).toEqual(["Chatwoot", "Mautic"]);
      expect(smtp[0].title).toContain("comegin/prod/chatwoot/SMTP_USERNAME・comegin/prod/chatwoot/SMTP_PASSWORD");
      expect(smtp[1].steps.join("\n")).toContain("put_smtp ~/Downloads/<CSV>.csv mautic");
    });

    it("入力: 段階 operate の古いキーと prod.conf の初期設定用の値は、削除の注意として ctx.warn に出し、聞かずに進む（値は出さない）", async () => {
      aws.responses["iam list-access-keys"] = {
        AccessKeyMetadata: [
          { Status: "Active", CreateDate: "2026-09-01T00:00:00Z" },
          { Status: "Active", CreateDate: "2026-10-01T00:00:00Z" },
        ],
      };
      const { ctx, rec } = applyCtx("operate", "no", { CHATWOOT_ADMIN_TOKEN: "tok-secret-value-0123456789" });
      await apply(ctx);
      expect(rec.asked).toEqual([]);
      expect(rec.warned.length).toBeGreaterThanOrEqual(2);
      expect(rec.warned.every((w) => w.endsWith("（削除の注意。止めずに進む）"))).toBe(true);
      expect(rec.warned.some((w) => w.includes("有効なアクセスキーが 2 つある"))).toBe(true);
      expect(rec.warned.some((w) => w.includes("CHATWOOT_ADMIN_TOKEN"))).toBe(true);
      expect(rec.warned.join("\n")).not.toContain("tok-secret-value-0123456789");
    });

    it("空入力: 段階 operate で何も残っていなければ、確認も削除の注意も出さない", async () => {
      const { ctx, rec } = applyCtx("operate", "no");
      await apply(ctx);
      expect(rec.asked).toEqual([]);
      expect(rec.warned).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: yes 以外なら最初の確認で止まり、後ろの確認は聞かない", async () => {
      aws.responses["sesv2 get-account"] = { ProductionAccessEnabled: false };
      dns.txt = [];
      const { ctx, rec } = applyCtx("apps", "no");
      const err = await apply(ctx).catch((e) => e);
      expect(err).toMatchObject({ id: "ses-production", kind: "confirm" });
      expect(rec.asked.map((a) => a.id)).toEqual(["ses-production"]);
    });

    it("入力: 段階 operate のサンドボックスと配信用の主体なしは、削除の注意ではないので確認する", async () => {
      aws.responses["sesv2 get-account"] = { ProductionAccessEnabled: false };
      aws.responses["iam list-entities-for-policy"] = { PolicyUsers: [], PolicyRoles: [], PolicyGroups: [] };
      const { ctx, rec } = applyCtx("operate");
      await apply(ctx);
      expect(rec.asked.map((a) => a.id)).toEqual(["deploy-principal", "ses-production"]);
      expect(rec.asked[0].steps.join("\n")).toContain("ComeginProdDeploy");
      // 配信の後の段階なので、「配信していないなら申請しない」の手順は付けない
      expect(rec.asked[1].steps[0]).not.toContain("まだ配信していないなら");
    });

    it("サーバ: IAM を読めない（権限）ときは、確かめられなかったことを AWS の認証と権限の手順付きで確認する", async () => {
      aws.responses["iam list-access-keys"] = new Error("AccessDenied: iam:ListAccessKeys");
      const { ctx, rec } = applyCtx("operate");
      await apply(ctx);
      const unknown = rec.asked.find((a) => a.id === "old-keys-unknown");
      expect(unknown.title).toContain("AccessDenied");
      expect(unknown.steps[0]).toContain("aws sts get-caller-identity");
    });

    it("サーバ: スタックが無いと、確認の前に例外で止まる", async () => {
      aws.main = null;
      const { ctx, rec } = applyCtx("operate");
      await expect(apply(ctx)).rejects.toThrow("スタック comegin-prod が無い");
      expect(rec.asked).toEqual([]);
    });
  });
});

// 段階 deploy の items（デプロイのずれの検知。2026-11-11）。git は ctx.run を偽物に差し替え、デプロイ設定ファイルは一時ディレクトリの偽のものを ctx.WORKTREE で読ませる。
describe("cloud の段階 deploy の items", () => {
  const RECORDED = "a".repeat(40);
  const NEWER = "c".repeat(40);
  const DEPLOY_KEYS = ["cloud.global-commit", "cloud.stack-commit", "cloud.lambda-code", "cloud.stack-params"];
  const SECRET_VALUE = "very-secret-admin@example.com";
  const SAMCONFIG_TEXT = [
    "version = 0.1",
    "[default.deploy.parameters]",
    "parameter_overrides = [",
    '  "DomainName=comegin.com",',
    '  "WireguardFixedAmiId=ami-0123",',
    '  "CloudFrontCertificateArn=arn:aws:acm:us-east-1:111:certificate/x",',
    '  "CloudFrontWebAclArn=arn:aws:wafv2:us-east-1:111:global/webacl/x",',
    '  "ChatwootImageTag=chatwoot-1",',
    `  "AdminBootstrapEmails=${SECRET_VALUE}",`,
    '  "DeployedCommit=unrecorded",',
    "]",
    "[global.deploy.parameters]",
    'parameter_overrides = [ "EnvName=prod" ]',
    "",
  ].join("\n");

  let worktree;
  beforeEach(() => {
    worktree = makeTempDir("comegin-deploy-items-");
    mkdirSync(join(worktree, "cloud"), { recursive: true });
    writeFileSync(join(worktree, "cloud/samconfig.toml"), SAMCONFIG_TEXT);
    // 設定ファイルに合わせた「同期済み」のスタック（NoEcho の AdminBootstrapEmails は値が **** で返る）
    aws.main.Parameters.push(
      { ParameterKey: "CloudFrontCertificateArn", ParameterValue: "arn:aws:acm:us-east-1:111:certificate/x" },
      { ParameterKey: "CloudFrontWebAclArn", ParameterValue: "arn:aws:wafv2:us-east-1:111:global/webacl/x" },
      { ParameterKey: "ChatwootImageTag", ParameterValue: "chatwoot-1" },
      { ParameterKey: "AdminBootstrapEmails", ParameterValue: "****" },
    );
    aws.global.Parameters.push({ ParameterKey: "EnvName", ParameterValue: "prod" });
  });
  afterEach(() => removeTempDir(worktree));

  /** git の応答。log(args) は git log の出力（新しい順の `sha<TAB>日時<TAB>件名` の行）を返す関数。calls に呼び出しを残す */
  function gitScene(overrides = {}) {
    const scene = { inMain: { [RECORDED]: true, [NEWER]: true }, log: () => "", logError: null, calls: [], ...overrides };
    scene.run = async (cmd, args) => {
      scene.calls.push([cmd, ...args]);
      if (cmd !== "git") throw new Error(`想定していない呼び出し: ${cmd}`);
      if (args[2] === "merge-base") {
        if (scene.inMain[args[4]]) return "";
        throw Object.assign(new Error("git merge-base が失敗した（終了コード 1）"), { exitCode: 1 });
      }
      if (args[2] === "log") {
        if (scene.logError) throw scene.logError;
        return scene.log(args);
      }
      throw new Error(`想定していない git の呼び出し: ${args.join(" ")}`);
    };
    return scene;
  }
  const entry = (sha, subject) => `${sha}\t2026-11-11T09:00:00+09:00\t${subject}\n`;
  /** git log の pathspec（-- の後ろ）に paths のどれかが含まれているときだけ out を返す */
  const logWhenPaths = (paths, out) => (args) => (paths.some((p) => args.slice(args.indexOf("--")).includes(p)) ? out : "");
  const deploy = (scene, conf = {}) => fakeCtx({ conf: { AWS_ACCOUNT_ID: "111", ...conf }, overrides: { phase: "deploy", WORKTREE: worktree, run: scene.run } });
  const setParam = (stack, key, value) => {
    stack.Parameters.find((p) => p.ParameterKey === key).ParameterValue = value;
  };

  describe("正常系", () => {
    it("入力: 記録の後の変更が無いと 4 つの key がすべて ok で、step は P2", async () => {
      const r = await check(deploy(gitScene()));
      expect(r.items.map((i) => i.key)).toEqual(DEPLOY_KEYS);
      expect(r.items.every((i) => i.level === "ok" && i.step === "P2")).toBe(true);
      for (const i of r.items) {
        expect(i.title.length).toBeGreaterThan(0);
        expect(i.evidence.length).toBeGreaterThan(0);
      }
      expect(itemsByKey(r)["cloud.stack-commit"].evidence).toContain("aaaaaaa");
    });

    it("入力: DeployedCommit が unrecorded だと cloud.stack-commit は action で、根拠に「記録が無い」と node cloud/deploy.mjs", async () => {
      setParam(aws.main, "DeployedCommit", "unrecorded");
      const scene = gitScene();
      const by = itemsByKey(await check(deploy(scene)));
      expect(by["cloud.stack-commit"].level).toBe("action");
      expect(by["cloud.stack-commit"].evidence).toContain("記録が無い");
      expect(by["cloud.stack-commit"].evidence).toContain("node cloud/deploy.mjs");
      expect(by["cloud.lambda-code"].level).toBe("action");
      expect(by["cloud.global-commit"].level).toBe("ok");
      expect(scene.calls.some((c) => c.includes("unrecorded"))).toBe(false); // 記録が無いときは git に渡さない
    });

    it("入力: 記録の後に cloud/stacks を変えたコミットが 1 件あると cloud.stack-commit は action で、根拠に短い SHA と件名", async () => {
      const scene = gitScene({ log: logWhenPaths(["cloud/stacks"], entry(NEWER, "mod: ALB のルールを足す")) });
      const by = itemsByKey(await check(deploy(scene)));
      expect(by["cloud.stack-commit"].level).toBe("action");
      expect(by["cloud.stack-commit"].evidence).toContain("ccccccc");
      expect(by["cloud.stack-commit"].evidence).toContain("mod: ALB のルールを足す");
      expect(by["cloud.stack-commit"].evidence).toContain("node cloud/deploy.mjs");
      expect(by["cloud.stack-commit"].evidence).not.toContain("--config-env global");
      expect(by["cloud.lambda-code"].level).toBe("ok");
      expect(by["cloud.global-commit"].level).toBe("ok");
    });

    it("入力: Lambda のパスだけが変わると cloud.lambda-code だけが action", async () => {
      const scene = gitScene({ log: logWhenPaths(["backend/consent-api/src"], entry(NEWER, "fix: 同意の記録")) });
      const by = itemsByKey(await check(deploy(scene)));
      expect(by["cloud.lambda-code"].level).toBe("action");
      expect(by["cloud.lambda-code"].evidence).toContain("同意の記録");
      for (const k of ["cloud.global-commit", "cloud.stack-commit", "cloud.stack-params"]) expect(by[k].level, k).toBe("ok");
    });

    it("入力: global のパスだけが変わると cloud.global-commit だけが action で、直すコマンドは --config-env global", async () => {
      const scene = gitScene({ log: logWhenPaths(["cloud/global"], entry(NEWER, "mod: WAF のルール")) });
      const by = itemsByKey(await check(deploy(scene)));
      expect(by["cloud.global-commit"].level).toBe("action");
      expect(by["cloud.global-commit"].evidence).toContain("node cloud/deploy.mjs --config-env global");
      for (const k of ["cloud.stack-commit", "cloud.lambda-code", "cloud.stack-params"]) expect(by[k].level, k).toBe("ok");
    });

    it("入力: items が action でも ok と notes は今と同じ", async () => {
      setParam(aws.main, "DeployedCommit", "unrecorded");
      setParam(aws.global, "DeployedCommit", "unrecorded");
      const r = await check(deploy(gitScene()));
      expect(r.items.filter((i) => i.level === "action")).toHaveLength(3);
      expect(r.ok).toBe(true);
      expect(r.notes).toEqual(["スタック comegin-prod: CREATE_COMPLETE（2026-10-30T00:00:00Z）"]);
    });

    it("入力: DeployedCommit の値が 40 桁の16進でも unrecorded でもない（空・大文字・桁違い・その他）と、git に渡さず「記録が無い」の action", async () => {
      for (const bad of ["", "ABCDEF", "g".repeat(40), "a".repeat(39), "a".repeat(41)]) {
        setParam(aws.main, "DeployedCommit", bad);
        const scene = gitScene();
        const by = itemsByKey(await check(deploy(scene)));
        expect(by["cloud.stack-commit"].level, bad).toBe("action");
        expect(by["cloud.stack-commit"].evidence, bad).toContain("記録が無い");
        if (bad) expect(scene.calls.flat().includes(bad), bad).toBe(false);
      }
      aws.main.Parameters = aws.main.Parameters.filter((p) => p.ParameterKey !== "DeployedCommit"); // パラメータそのものが無い
      expect(itemsByKey(await check(deploy(gitScene())))["cloud.stack-commit"].evidence).toContain("記録が無い");
    });

    it("入力: 設定ファイルの値と同じなら cloud.stack-params は ok（NoEcho の **** と DeployedCommit は比べず、値は出さない）", async () => {
      const i = itemsByKey(await check(deploy(gitScene())))["cloud.stack-params"];
      expect(i.level).toBe("ok");
      expect(i.evidence).not.toContain(SECRET_VALUE);
    });
  });

  describe("異常系", () => {
    it("入力: samconfig の ChatwootImageTag とスタックのパラメータが違うと cloud.stack-params は action で、根拠にパラメータの名前があり値が無い", async () => {
      setParam(aws.main, "ChatwootImageTag", "chatwoot-0");
      const r = await check(deploy(gitScene()));
      const i = itemsByKey(r)["cloud.stack-params"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("ChatwootImageTag");
      expect(i.evidence).toContain("node cloud/deploy.mjs");
      const all = JSON.stringify(r);
      for (const value of ["chatwoot-0", "chatwoot-1", SECRET_VALUE, "ami-0123"]) expect(all, value).not.toContain(value);
      expect(itemsByKey(r)["cloud.stack-commit"].level).toBe("ok");
    });

    it("入力: global スタックのパラメータが違うと名前を global として出し、直すコマンドは --config-env global", async () => {
      setParam(aws.global, "EnvName", "stg");
      const i = itemsByKey(await check(deploy(gitScene())))["cloud.stack-params"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("global");
      expect(i.evidence).toContain("EnvName");
      expect(i.evidence).toContain("node cloud/deploy.mjs --config-env global");
    });

    it("入力: 設定ファイルにあってスタックに無いパラメータも、名前だけを出して action", async () => {
      aws.main.Parameters = aws.main.Parameters.filter((p) => p.ParameterKey !== "WireguardFixedAmiId");
      const i = itemsByKey(await check(deploy(gitScene())))["cloud.stack-params"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("WireguardFixedAmiId");
      expect(i.evidence).not.toContain("ami-0123");
    });

    it("入力: 作業ツリーに cloud/samconfig.toml が無いと cloud.stack-params は unknown で、ほかの項目は続く", async () => {
      removeTempDir(join(worktree, "cloud"));
      const by = itemsByKey(await check(deploy(gitScene())));
      expect(by["cloud.stack-params"].level).toBe("unknown");
      expect(by["cloud.stack-commit"].level).toBe("ok");
    });

    it("入力: 記録のコミットが origin/main の履歴に無いと warn で、履歴に無いコミットの短い SHA を示す", async () => {
      setParam(aws.main, "DeployedCommit", "d".repeat(40));
      const by = itemsByKey(await check(deploy(gitScene())));
      expect(by["cloud.stack-commit"].level).toBe("warn");
      expect(by["cloud.stack-commit"].evidence).toContain("ddddddd");
      expect(by["cloud.stack-commit"].evidence).toContain("origin/main の履歴に無い");
      expect(by["cloud.lambda-code"].level).toBe("warn");
    });

    it("サーバ: git が失敗する（origin/main が無いなど）と、コミットの 3 項目だけ unknown になり、パラメータの項目は続く", async () => {
      const scene = gitScene({ logError: new Error("git log が失敗した（終了コード 128）\nfatal: bad revision 'origin/main'") });
      const r = await check(deploy(scene));
      const by = itemsByKey(r);
      for (const k of ["cloud.global-commit", "cloud.stack-commit", "cloud.lambda-code"]) {
        expect(by[k].level, k).toBe("unknown");
        expect(by[k].evidence, k).toContain("git");
      }
      expect(by["cloud.stack-params"].level).toBe("ok");
      expect(r.ok).toBe(true);
    });

    it("サーバ: 既定の ctx.run（常に失敗する）でも例外にならず、コミットの 3 項目は unknown", async () => {
      const ctx = fakeCtx({ conf: { AWS_ACCOUNT_ID: "111" }, overrides: { phase: "deploy", WORKTREE: worktree } });
      const by = itemsByKey(await check(ctx));
      for (const k of ["cloud.global-commit", "cloud.stack-commit", "cloud.lambda-code"]) expect(by[k].level, k).toBe("unknown");
    });

    it("サーバ: 本番スタックが無いと、stack-commit と lambda-code は action（スタックが無い）で、items は返る", async () => {
      aws.main = null;
      const r = await check(deploy(gitScene()));
      const by = itemsByKey(r);
      expect(by["cloud.stack-commit"].level).toBe("action");
      expect(by["cloud.stack-commit"].evidence).toContain("スタック comegin-prod が無い");
      expect(by["cloud.lambda-code"].level).toBe("action");
      expect(by["cloud.global-commit"].level).toBe("ok");
      expect(r.ok).toBe(false);
    });

    it("サーバ: 本番スタックが ROLLBACK_COMPLETE だと、記録（試みたコミット）が残っていても ok にせず、stack-commit と lambda-code は action（消して作り直す）で、stack-params は unknown", async () => {
      aws.main.StackStatus = "ROLLBACK_COMPLETE"; // DeployedCommit は a*40 のまま（試みた記録が Parameters に残る）
      const scene = gitScene();
      const by = itemsByKey(await check(deploy(scene)));
      for (const k of ["cloud.stack-commit", "cloud.lambda-code"]) {
        expect(by[k].level, k).toBe("action");
        expect(by[k].evidence, k).toContain("ROLLBACK_COMPLETE");
        expect(by[k].evidence, k).toContain("delete-stack --region ap-northeast-1 --stack-name comegin-prod");
        expect(by[k].evidence, k).toContain("node cloud/deploy.mjs");
      }
      expect(by["cloud.stack-params"].level).toBe("unknown"); // 本番スタックは比べない
      expect(by["cloud.stack-params"].evidence).toContain("ROLLBACK_COMPLETE");
      expect(by["cloud.global-commit"].level).toBe("ok"); // global は別のスタック
      expect(scene.calls.filter((c) => c[3] === "merge-base").length).toBe(1); // 本番スタックの記録は git に渡さない（global の分だけ）
    });

    it("サーバ: global スタックが ROLLBACK_COMPLETE だと cloud.global-commit は action で、消す場所は us-east-1 と --config-env global", async () => {
      aws.global.StackStatus = "ROLLBACK_COMPLETE";
      const i = itemsByKey(await check(deploy(gitScene())))["cloud.global-commit"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("delete-stack --region us-east-1 --stack-name comegin-global-prod");
      expect(i.evidence).toContain("node cloud/deploy.mjs --config-env global");
    });

    it("入力: UPDATE_ROLLBACK_COMPLETE（更新が戻されただけで、前の版が動いている）は記録を信用して比べる", async () => {
      aws.main.StackStatus = "UPDATE_ROLLBACK_COMPLETE";
      const by = itemsByKey(await check(deploy(gitScene())));
      expect(by["cloud.stack-commit"].level).toBe("ok");
    });

    it("サーバ: 更新に失敗した状態（UPDATE_FAILED など COMPLETE でないもの）は記録を信用せず unknown", async () => {
      aws.main.StackStatus = "UPDATE_FAILED";
      const by = itemsByKey(await check(deploy(gitScene())));
      expect(by["cloud.stack-commit"].level).toBe("unknown");
      expect(by["cloud.lambda-code"].level).toBe("unknown");
    });

    it("入力: 設定ファイルの表の名前が違って比べられるパラメータが 0 個だと、ok ではなく unknown", async () => {
      writeFileSync(join(worktree, "cloud/samconfig.toml"), SAMCONFIG_TEXT.replace("[default.deploy.parameters]", "[defualt.deploy.parameters]"));
      const i = itemsByKey(await check(deploy(gitScene())))["cloud.stack-params"];
      expect(i.level).toBe("unknown");
      expect(i.evidence).toContain("default.deploy.parameters");
    });

    it("入力: 前後の空白や外側の二重引用符だけの違いは食い違いにしない（中身が違えば名前だけを出す）", async () => {
      writeFileSync(
        join(worktree, "cloud/samconfig.toml"),
        SAMCONFIG_TEXT.replace('"ChatwootImageTag=chatwoot-1"', '"ChatwootImageTag=\\"chatwoot-1\\""').replace('"DomainName=comegin.com"', '"DomainName= comegin.com "'),
      );
      expect(itemsByKey(await check(deploy(gitScene())))["cloud.stack-params"].level).toBe("ok");
      writeFileSync(join(worktree, "cloud/samconfig.toml"), SAMCONFIG_TEXT.replace('"ChatwootImageTag=chatwoot-1"', '"ChatwootImageTag=\\"chatwoot-2\\""'));
      const i = itemsByKey(await check(deploy(gitScene())))["cloud.stack-params"];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("ChatwootImageTag");
      expect(i.evidence).not.toContain("chatwoot-2");
    });

    it("サーバ: スタックが更新中（*_IN_PROGRESS）だと、記録は信用できないので unknown", async () => {
      aws.main.StackStatus = "UPDATE_IN_PROGRESS";
      const by = itemsByKey(await check(deploy(gitScene())));
      expect(by["cloud.stack-commit"].level).toBe("unknown");
      expect(by["cloud.stack-commit"].evidence).toContain("UPDATE_IN_PROGRESS");
    });
  });
});

// 段階 images の items（派生イメージの古さの検知。2026-11-11）。記録のタグ <タグ>-rev-<40 桁> を ECR の imageTags から読み、git は ctx.run の偽物で答える。
describe("cloud の段階 images の items", () => {
  const OLD = "1".repeat(40);
  const MID = "2".repeat(40);
  const NEW = "3".repeat(40);
  const OUT = "9".repeat(40); // origin/main の履歴に無いコミット
  const CW_TAG = "v4.18.0-1";
  const MA_TAG = "7.2.0-3";
  const CW_REPO = "comegin/prod/chatwoot";
  const MA_REPO = "comegin/prod/mautic";
  const NEWER = "c".repeat(40);

  beforeEach(() => {
    aws.main.Parameters.push({ ParameterKey: "ChatwootImageTag", ParameterValue: CW_TAG }, { ParameterKey: "MauticImageTag", ParameterValue: MA_TAG });
  });

  /** ECR の応答。tags は { リポジトリ名: imageTags の配列 | null（イメージが無い） } */
  function ecr(tags) {
    aws.responses["ecr describe-images"] = (args) => {
      const t = tags[args[args.indexOf("--repository-name") + 1]];
      return t === null || t === undefined ? null : { imageDetails: [{ imageTags: t }] };
    };
  }
  /** 本来のタグと、記録のタグ（コミットごと）を足した imageTags */
  const withRevs = (tag, ...commits) => [tag, ...commits.map((c) => `${tag}-rev-${c}`)];

  /** git の応答。behind は { コミット: origin/main までのコミット数 }（キーに無いコミットは origin/main の履歴に無い）。log(args) は git log の出力 */
  function gitScene(overrides = {}) {
    const scene = { behind: { [OLD]: 9, [MID]: 5, [NEW]: 2 }, log: () => "", logError: null, calls: [], ...overrides };
    scene.run = async (cmd, args) => {
      scene.calls.push([cmd, ...args]);
      if (cmd !== "git") throw new Error(`想定していない呼び出し: ${cmd}`);
      if (args[2] === "merge-base") {
        if (args[4] in scene.behind) return "";
        throw Object.assign(new Error("git merge-base が失敗した（終了コード 1）"), { exitCode: 1 });
      }
      if (args[2] === "rev-list") return `${scene.behind[args[4].split("..")[0]]}\n`;
      if (args[2] === "log") {
        if (scene.logError) throw scene.logError;
        return scene.log(args);
      }
      throw new Error(`想定していない git の呼び出し: ${args.join(" ")}`);
    };
    return scene;
  }
  const entry = (sha, subject) => `${sha}\t2026-11-11T09:00:00+09:00\t${subject}\n`;
  const logWhenPaths = (paths, out) => (args) => (paths.some((p) => args.slice(args.indexOf("--")).includes(p)) ? out : "");
  const images = (scene) => fakeCtx({ conf: { AWS_ACCOUNT_ID: "111" }, overrides: { phase: "images", run: scene.run } });
  const logCalls = (scene) => scene.calls.filter((c) => c[3] === "log").map((c) => c[5]);

  describe("正常系", () => {
    it("入力: 両方 clean なら cloud.image-commit は ok で、step は P3、根拠に Chatwoot と Mautic", async () => {
      ecr({ [CW_REPO]: withRevs(CW_TAG, NEW), [MA_REPO]: withRevs(MA_TAG, NEW) });
      const r = await check(images(gitScene()));
      expect(r.items.map((i) => i.key)).toEqual(["cloud.image-commit"]);
      const i = r.items[0];
      expect(i.level).toBe("ok");
      expect(i.step).toBe("P3");
      expect(i.title.length).toBeGreaterThan(0);
      expect(i.evidence).toContain("Chatwoot");
      expect(i.evidence).toContain("Mautic");
      expect(i.evidence).toContain("3333333");
    });

    it("入力: rev- が 2 つあると newestInMain の結果（origin/main までが近いほう）で比べる", async () => {
      ecr({ [CW_REPO]: withRevs(CW_TAG, OLD, NEW), [MA_REPO]: withRevs(MA_TAG, NEW) });
      const scene = gitScene({ log: logWhenPaths(["cloud/images/chatwoot"], entry(NEWER, "mod: Dockerfile")) });
      const r = await check(images(scene));
      expect(logCalls(scene)).toContain(`${NEW}..origin/main`); // 新しいほうを記録とする
      expect(logCalls(scene)).not.toContain(`${OLD}..origin/main`);
      expect(r.items[0].level).toBe("action");
      expect(r.items[0].evidence).toContain("3333333");
    });

    it("入力: 記録の後に cloud/images/mautic の upstream.json が変わると action で、根拠に Mautic と件名と node cloud/images/build-push.mjs mautic", async () => {
      ecr({ [CW_REPO]: withRevs(CW_TAG, NEW), [MA_REPO]: withRevs(MA_TAG, MID) });
      const scene = gitScene({ log: logWhenPaths(["cloud/images/mautic"], entry(NEWER, "mod: Mautic の上流を上げる")) });
      const r = await check(images(scene));
      const i = r.items[0];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("Mautic");
      expect(i.evidence).toContain("ccccccc");
      expect(i.evidence).toContain("mod: Mautic の上流を上げる");
      expect(i.evidence).toContain("node cloud/images/build-push.mjs mautic");
      expect(i.evidence).not.toContain("build-push.mjs chatwoot");
      expect(logCalls(scene)).toContain(`${MID}..origin/main`);
      const paths = scene.calls.filter((c) => c[3] === "log" && c.includes(`${MID}..origin/main`)).flat();
      expect(paths).toContain("cloud/images/mautic");
    });

    it("入力: ok と notes は今と同じ（イメージが ECR にあれば ok）", async () => {
      ecr({ [CW_REPO]: withRevs(CW_TAG, OLD), [MA_REPO]: [MA_TAG] });
      const r = await check(images(gitScene()));
      expect(r.ok).toBe(true);
      expect(r.notes).toEqual([`${CW_REPO}:${CW_TAG} は ECR にある`, `${MA_REPO}:${MA_TAG} は ECR にある`]);
    });
  });

  describe("異常系", () => {
    it("入力: imageTags に rev- が無いと action で、根拠に「記録が無い」と node cloud/images/build-push.mjs chatwoot", async () => {
      ecr({ [CW_REPO]: [CW_TAG], [MA_REPO]: withRevs(MA_TAG, NEW) });
      const scene = gitScene();
      const i = (await check(images(scene))).items[0];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("Chatwoot");
      expect(i.evidence).toContain("記録が無い");
      expect(i.evidence).toContain("node cloud/images/build-push.mjs chatwoot");
      expect(i.evidence).not.toContain("build-push.mjs mautic");
    });

    it("空入力: imageTags が空（キーごと無い）でも「記録が無い」の action で、例外にならない", async () => {
      aws.responses["ecr describe-images"] = (args) => ({ imageDetails: [args.includes(CW_REPO) ? {} : { imageTags: [] }] });
      const r = await check(images(gitScene()));
      expect(r.items[0].level).toBe("action");
      expect(r.items[0].evidence.match(/記録が無い/g)).toHaveLength(2);
    });

    it("入力: 40 桁の16進でない rev- のタグ（短い・大文字・末尾が違う）は記録に数えない", async () => {
      const bad = [`${CW_TAG}-rev-${"a".repeat(39)}`, `${CW_TAG}-rev-${"A".repeat(40)}`, `${CW_TAG}-rev-${"a".repeat(40)}-x`, `rev-${"a".repeat(40)}`];
      ecr({ [CW_REPO]: [CW_TAG, ...bad], [MA_REPO]: withRevs(MA_TAG, NEW) });
      const scene = gitScene();
      const i = (await check(images(scene))).items[0];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("記録が無い");
      expect(logCalls(scene).every((r) => r.startsWith(NEW))).toBe(true);
    });

    it("入力: 記録のコミットが origin/main の履歴に無いと warn（もう一方が ok のとき）で、短い SHA を示す", async () => {
      ecr({ [CW_REPO]: withRevs(CW_TAG, OUT), [MA_REPO]: withRevs(MA_TAG, NEW) });
      const i = (await check(images(gitScene()))).items[0];
      expect(i.level).toBe("warn");
      expect(i.evidence).toContain("9999999");
      expect(i.evidence).toContain("origin/main の履歴に無い");
    });

    it("入力: 片方が warn で片方が action なら、重い action になる", async () => {
      ecr({ [CW_REPO]: withRevs(CW_TAG, OUT), [MA_REPO]: [MA_TAG] });
      const i = (await check(images(gitScene()))).items[0];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("9999999");
      expect(i.evidence).toContain("build-push.mjs mautic");
    });

    it("サーバ: git が失敗する（origin/main が無いなど）とその項目が unknown で、例外にならず ok と notes は変わらない", async () => {
      ecr({ [CW_REPO]: withRevs(CW_TAG, NEW), [MA_REPO]: withRevs(MA_TAG, NEW) });
      const scene = gitScene({ logError: new Error("git log が失敗した（終了コード 128）\nfatal: bad revision 'origin/main'") });
      const r = await check(images(scene));
      expect(r.items[0].level).toBe("unknown");
      expect(r.items[0].evidence).toContain("git");
      expect(r.ok).toBe(true);
    });

    it("サーバ: ECR にイメージが無いと action（ECR に無い）で、ok は false のまま", async () => {
      ecr({ [CW_REPO]: null, [MA_REPO]: withRevs(MA_TAG, NEW) });
      const r = await check(images(gitScene()));
      expect(r.ok).toBe(false);
      expect(r.items[0].level).toBe("action");
      expect(r.items[0].evidence).toContain("ECR に無い");
      expect(r.items[0].evidence).toContain("node cloud/images/build-push.mjs chatwoot");
    });

    it("サーバ: 本番スタックが無いと ok は false で、cloud.image-commit は action（スタックが無い。Task 4 の項目と同じ扱い）", async () => {
      aws.main = null;
      const r = await check(images(gitScene()));
      expect(r.ok).toBe(false);
      expect(itemsByKey(r)["cloud.image-commit"].level).toBe("action");
      expect(itemsByKey(r)["cloud.image-commit"].evidence).toContain("スタック comegin-prod が無い");
    });

    it("サーバ: 本番スタックが更新中や *_FAILED だと、タグ（パラメータ）を信用せず unknown で、git には触れない", async () => {
      ecr({ [CW_REPO]: withRevs(CW_TAG, NEW), [MA_REPO]: withRevs(MA_TAG, NEW) });
      for (const status of ["UPDATE_IN_PROGRESS", "UPDATE_FAILED", "CREATE_FAILED"]) {
        aws.main.StackStatus = status;
        const scene = gitScene();
        const i = (await check(images(scene))).items[0];
        expect(i.level, status).toBe("unknown");
        expect(i.evidence, status).toContain(status);
        expect(scene.calls, status).toEqual([]);
      }
    });

    it("サーバ: 本番スタックが ROLLBACK_COMPLETE だと action（消して作り直す）で、git には触れない", async () => {
      ecr({ [CW_REPO]: withRevs(CW_TAG, NEW), [MA_REPO]: withRevs(MA_TAG, NEW) });
      aws.main.StackStatus = "ROLLBACK_COMPLETE";
      const scene = gitScene();
      const i = (await check(images(scene))).items[0];
      expect(i.level).toBe("action");
      expect(i.evidence).toContain("ROLLBACK_COMPLETE");
      expect(scene.calls).toEqual([]);
    });

    it("入力: 「記録が無い」「changed」「outside-main」の案内は、タグ不変のため 連番を上げたタグ → build-push → deploy の順で書く（ECR に無いタグをデプロイしない）", async () => {
      const order = (text, product, param) => {
        const a = text.indexOf(`連番を上げたタグを samconfig.toml の ${param} に書く`);
        const b = text.indexOf(`node cloud/images/build-push.mjs ${product}`, a);
        const c = text.indexOf("node cloud/deploy.mjs", b);
        return a >= 0 && b > a && c > b;
      };
      ecr({ [CW_REPO]: [CW_TAG], [MA_REPO]: withRevs(MA_TAG, NEW) }); // 記録が無い
      expect(order((await check(images(gitScene()))).items[0].evidence, "chatwoot", "ChatwootImageTag")).toBe(true);
      ecr({ [CW_REPO]: withRevs(CW_TAG, NEW), [MA_REPO]: withRevs(MA_TAG, NEW) }); // changed
      const changed = gitScene({ log: logWhenPaths(["cloud/images/mautic"], entry(NEWER, "mod: Dockerfile")) });
      expect(order((await check(images(changed))).items[0].evidence, "mautic", "MauticImageTag")).toBe(true);
      ecr({ [CW_REPO]: withRevs(CW_TAG, OUT), [MA_REPO]: withRevs(MA_TAG, NEW) }); // outside-main
      expect(order((await check(images(gitScene()))).items[0].evidence, "chatwoot", "ChatwootImageTag")).toBe(true);
    });
  });
});
