// cloud/lib/samconfig.mjs（デプロイ設定ファイルの parameter_overrides の読み取り）と cloud/lib/images.mjs（upstream.json の読み取り）の単体テスト。
// 設定ファイルの例は cloud/ の雛形（.example）と同じ形で、ダミーの値だけ。実体のデプロイ設定ファイルには触れない。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUpstream } from "../../../cloud/lib/images.mjs";
import { overrideValue, parameterOverrides, withDeployedCommit } from "../../../cloud/lib/samconfig.mjs";
import { makeTempDir, removeTempDir } from "../helpers/temp-home.mjs";

const TOML = `
version = 0.1

# 本番
[default.global.parameters]
stack_name = "comegin-prod"

[default.deploy.parameters]
region = "ap-northeast-1"
capabilities = "CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND"
# 必須の値だけを書く。
parameter_overrides = [
  "EnvName=prod",
  "RunLogAdminPrincipalArns=arn:aws:iam::123456789012:user/REPLACE-ME", # 末尾のコメント
  "CloudFrontCertificateArn=arn:aws:acm:us-east-1:123456789012:certificate/REPLACE-ME",
  "ChatwootImageTag=v4.18.0-1",
]

[global.global.parameters]
stack_name = "comegin-global-prod"

[global.deploy.parameters]
region = "us-east-1"
parameter_overrides = [
  "EnvName=prod",
]
`;

describe("parameterOverrides: 正常系", () => {
  it("入力: default は 4 要素を順番どおりに返す", () => {
    expect(parameterOverrides(TOML, "default")).toEqual([
      "EnvName=prod",
      "RunLogAdminPrincipalArns=arn:aws:iam::123456789012:user/REPLACE-ME",
      "CloudFrontCertificateArn=arn:aws:acm:us-east-1:123456789012:certificate/REPLACE-ME",
      "ChatwootImageTag=v4.18.0-1",
    ]);
  });

  it("入力: global は EnvName=prod だけ", () => {
    expect(parameterOverrides(TOML, "global")).toEqual(["EnvName=prod"]);
  });

  it("入力: 1 行の配列と、値の中の ] や # を読める", () => {
    const text = `[default.deploy.parameters]\nparameter_overrides = ["A=x]y", "B=#z", 'C=lit']\n`;
    expect(parameterOverrides(text, "default")).toEqual(["A=x]y", "B=#z", "C=lit"]);
  });

  it("入力: CRLF の改行でも読める", () => {
    expect(parameterOverrides(TOML.replace(/\n/g, "\r\n"), "global")).toEqual(["EnvName=prod"]);
  });
});

describe("parameterOverrides: 異常系", () => {
  it("空入力: 空の文字列は []", () => {
    expect(parameterOverrides("", "default")).toEqual([]);
  });

  it("入力: 表が無い env は []", () => {
    expect(parameterOverrides(`[staging.deploy.parameters]\nparameter_overrides = ["A=1"]\n`, "default")).toEqual([]);
  });

  it("入力: 表があって parameter_overrides が無いなら []", () => {
    expect(parameterOverrides(`[default.deploy.parameters]\nregion = "x"\n`, "default")).toEqual([]);
  });

  it("入力: 別の表の parameter_overrides は拾わない", () => {
    const text = `[default.deploy.parameters]\nregion = "x"\n[global.deploy.parameters]\nparameter_overrides = ["A=1"]\n`;
    expect(parameterOverrides(text, "default")).toEqual([]);
  });

  it("入力: 配列が閉じていないと、値を含めずに例外", () => {
    const text = `[default.deploy.parameters]\nparameter_overrides = [\n  "Secret=do-not-print",\n`;
    expect(() => parameterOverrides(text, "default")).toThrow(/閉じていない/);
    try {
      parameterOverrides(text, "default");
    } catch (e) {
      expect(e.message).not.toContain("do-not-print");
    }
  });

  it("入力: 配列でない書き方（文字列）は、値を含めずに例外", () => {
    const text = `[default.deploy.parameters]\nparameter_overrides = "A=do-not-print"\n`;
    expect(() => parameterOverrides(text, "default")).toThrow(/配列/);
    try {
      parameterOverrides(text, "default");
    } catch (e) {
      expect(e.message).not.toContain("do-not-print");
    }
  });
});

describe("withDeployedCommit", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("入力: 既にある DeployedCommit=unrecorded を置き換え、末尾に置く", () => {
    expect(withDeployedCommit(["EnvName=prod", "DeployedCommit=unrecorded", "X=1"], SHA)).toEqual(["EnvName=prod", "X=1", `DeployedCommit=${SHA}`]);
  });

  it("空入力: [] なら DeployedCommit だけ", () => {
    expect(withDeployedCommit([], SHA)).toEqual([`DeployedCommit=${SHA}`]);
  });

  it("入力: 元の配列を書き換えない", () => {
    const src = ["EnvName=prod"];
    withDeployedCommit(src, SHA);
    expect(src).toEqual(["EnvName=prod"]);
  });

  it("入力: 40 桁でないコミットは例外", () => {
    expect(() => withDeployedCommit([], "abc")).toThrow(/40 桁/);
  });
});

describe("overrideValue", () => {
  it("入力: 名前に合う値を返し、無ければ undefined", () => {
    expect(overrideValue(["A=1", "B=x=y"], "B")).toBe("x=y");
    expect(overrideValue(["A=1"], "B")).toBeUndefined();
  });
});

describe("readUpstream", () => {
  let dir;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => removeTempDir(dir));

  const write = (product, body) => {
    mkdirSync(join(dir, product), { recursive: true });
    writeFileSync(join(dir, product, "upstream.json"), body);
  };
  const DIGEST = `sha256:${"a".repeat(64)}`;

  it("入力: tag と digest を返す", () => {
    write("chatwoot", JSON.stringify({ tag: "v1", digest: DIGEST }));
    expect(readUpstream("chatwoot", dir)).toEqual({ tag: "v1", digest: DIGEST });
  });

  it("入力: 実際の cloud/images の値（chatwoot・mautic）を読める", () => {
    expect(readUpstream("chatwoot")).toEqual({ tag: "v4.18.0", digest: "sha256:b419dded7e9d2f54a24fd427b74ba7e6069d601b500618045c1eb6c01a1cc9a1" });
    expect(readUpstream("mautic")).toEqual({ tag: "7.2.0-apache", digest: "sha256:dea3bb71a5c5bf4c0c7d1764e58a32109898e7b2e6a710f14f50e2a913c03a0f" });
  });

  it("異常系: digest の形が違うと例外", () => {
    write("chatwoot", JSON.stringify({ tag: "v1", digest: "sha256:short" }));
    expect(() => readUpstream("chatwoot", dir)).toThrow(/digest/);
  });

  it("異常系: tag が無いと例外", () => {
    write("chatwoot", JSON.stringify({ digest: DIGEST }));
    expect(() => readUpstream("chatwoot", dir)).toThrow(/tag/);
  });

  it("異常系: 知らない製品は例外", () => {
    expect(() => readUpstream("unknown", dir)).toThrow(/製品/);
  });

  it("異常系: ファイルが無い・JSON でないときは例外", () => {
    expect(() => readUpstream("chatwoot", dir)).toThrow(/upstream\.json/);
    write("mautic", "{not json");
    expect(() => readUpstream("mautic", dir)).toThrow(/upstream\.json/);
  });
});
