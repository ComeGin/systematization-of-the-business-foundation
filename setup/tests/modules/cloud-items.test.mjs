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
  ],
};

function healthyAws() {
  aws.main = structuredClone(MAIN_STACK);
  aws.global = { StackStatus: "CREATE_COMPLETE", Parameters: [{ ParameterKey: "DistributionArn", ParameterValue: "arn:aws:cloudfront::111:distribution/X" }] };
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
