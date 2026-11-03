import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSecrets, redact } from "../../src/status/redact.js";
import { tempDir } from "../helpers/runner.js";

let home: string;
let cleanup: () => void;
beforeEach(() => {
  ({ dir: home, cleanup } = tempDir("cp-redact-"));
});
afterEach(() => cleanup());

const setupDir = () => {
  const dir = join(home, ".config/comegin/setup");
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("redact", () => {
  describe("正常系", () => {
    it("入力: 短い値が長い値の一部でも長い値が先に伏せられる", () => {
      const long = "abcdef-SECRET-123456";
      const short = "SECRET-123";
      expect(redact(`x ${long} y ${short} z`, [short, long])).toBe("x [伏せ字] y [伏せ字] z");
    });

    it("入力: 同じ値が何度出てもすべて伏せる", () => {
      expect(redact("tok1234 と tok1234", ["tok1234"])).toBe("[伏せ字] と [伏せ字]");
    });
  });

  describe("異常系", () => {
    it("空入力: 伏せる値が空なら文はそのまま（空文字の値は無視する）", () => {
      expect(redact("そのまま", [])).toBe("そのまま");
      expect(redact("そのまま", [""])).toBe("そのまま");
    });
  });
});

describe("collectSecrets", () => {
  describe("正常系", () => {
    it("入力: prod.conf の 8 文字以上の値を集め、場所のキー（_URL など）と短い値は集めない", () => {
      writeFileSync(
        join(setupDir(), "prod.conf"),
        [
          "# コメント",
          "MAUTIC_CLIENT_SECRET=conf-secret-value-1",
          'ADMIN_EMAIL="owner@example.test"',
          "CHATWOOT_BASE_URL=https://chat.example.test",
          "OPENSEO_SKIP_GSC=yes",
          "CONTROL_ADMIN_EMAILS=a-user@example.test,b-user@example.test",
        ].join("\n"),
      );
      const secrets = collectSecrets(home);
      expect(secrets).toEqual(
        expect.arrayContaining([
          "conf-secret-value-1",
          "owner@example.test",
          "a-user@example.test",
          "b-user@example.test",
        ]),
      );
      expect(secrets).not.toContain("https://chat.example.test");
      expect(secrets).not.toContain("yes");
    });

    it("入力: prod.state.json は secrets に載ったキーの値だけを集める", () => {
      writeFileSync(
        join(setupDir(), "prod.state.json"),
        JSON.stringify({ values: { N8N_API_KEY: "state-secret-xyz", PUBLIC_ID: "not-a-secret-value" }, secrets: ["N8N_API_KEY"] }),
      );
      const secrets = collectSecrets(home);
      expect(secrets).toContain("state-secret-xyz");
      expect(secrets).not.toContain("not-a-secret-value");
    });

    it("入力: AWS の資格情報ファイルからは aws_* のキーの値だけを集める（region は伏せない）", () => {
      const aws = join(home, "aws-credentials");
      writeFileSync(aws, "[default]\nregion = ap-northeast-1\noutput = json-output\naws_session_token = session-token-value\n");
      const secrets = collectSecrets(home, [aws]);
      expect(secrets).toEqual(["session-token-value"]);
      expect(redact("リージョン ap-northeast-1", secrets)).toBe("リージョン ap-northeast-1");
    });

    it("入力: 資格情報ファイル（INI）の値と、トークンのファイルの中身を集める", () => {
      const aws = join(home, "aws-credentials");
      const token = join(home, "github-token");
      writeFileSync(aws, "[default]\naws_access_key_id = AKIAEXAMPLE000001\naws_secret_access_key = aws/secret+value\n");
      writeFileSync(token, "github_pat_example_token\n");
      const secrets = collectSecrets(home, [aws, token]);
      expect(secrets).toEqual(expect.arrayContaining(["AKIAEXAMPLE000001", "aws/secret+value", "github_pat_example_token"]));
      expect(secrets).not.toContain("[default]");
    });
  });

  describe("異常系", () => {
    it("空入力: ファイルが無ければ空の一覧（投げない）", () => {
      expect(collectSecrets(home, [join(home, "missing")])).toEqual([]);
    });

    it("入力: 壊れた prod.state.json は読まずに飛ばす", () => {
      writeFileSync(join(setupDir(), "prod.state.json"), "{ broken");
      expect(() => collectSecrets(home)).not.toThrow();
    });
  });
});
