import { describe, expect, it } from "vitest";
import { ConfigError, loadAlbConfig, loadConfig, parseAlbConfig, parseConfig } from "../src/config.js";
import { captureStderr, DB_PASSWORD, mockExit, SECRET, validEnv } from "./helpers/env.js";

// 環境変数の検証だけを見る純粋な関数なので、サーバ側の異常は無い

function expectExit(fn: () => unknown) {
  const exit = mockExit();
  const stderr = captureStderr();
  expect(fn).toThrow("process.exit(1)");
  expect(exit).toHaveBeenCalledWith(1);
  return stderr.text();
}

describe("loadConfig", () => {
  describe("正常系", () => {
    it("空入力: 必須の変数だけ（任意の変数は未設定）なら既定値を補う", () => {
      const config = loadConfig(validEnv());
      expect(config).toMatchObject({
        NODE_ENV: "development",
        HOST: "0.0.0.0",
        PORT: 3103,
        DATABASE_PORT: 5432,
        DATABASE_NAME: "admin_auth",
        DATABASE_SSL: false,
        GOOGLE_HOSTED_DOMAIN: "comegin.com",
        ADMIN_BOOTSTRAP_EMAILS: [],
      });
    });

    it("BETTER_AUTH_URL はパスとクエリを落としてオリジンにする", () => {
      expect(loadConfig(validEnv({ BETTER_AUTH_URL: "https://auth.comegin.com/api/auth?x=1" })).BETTER_AUTH_URL).toBe(
        "https://auth.comegin.com",
      );
    });

    it("DATABASE_SSL は文字列の true だけを真にする", () => {
      expect(loadConfig(validEnv({ DATABASE_SSL: "true" })).DATABASE_SSL).toBe(true);
      expect(loadConfig(validEnv({ DATABASE_SSL: "false" })).DATABASE_SSL).toBe(false);
    });

    it("GOOGLE_HOSTED_DOMAIN は小文字のドメイン名を受け付ける", () => {
      expect(loadConfig(validEnv({ GOOGLE_HOSTED_DOMAIN: "example.co.jp" })).GOOGLE_HOSTED_DOMAIN).toBe("example.co.jp");
    });

    it("ADMIN_BOOTSTRAP_EMAILS は前後の空白を除き、小文字にし、空の要素を捨てる", () => {
      const config = loadConfig(validEnv({ ADMIN_BOOTSTRAP_EMAILS: " Alice@Comegin.com , ,bob@comegin.com," }));
      expect(config.ADMIN_BOOTSTRAP_EMAILS).toEqual(["alice@comegin.com", "bob@comegin.com"]);
    });

    it("空入力: ADMIN_BOOTSTRAP_EMAILS が空文字・空白とカンマだけなら空の一覧にする", () => {
      expect(loadConfig(validEnv({ ADMIN_BOOTSTRAP_EMAILS: "" })).ADMIN_BOOTSTRAP_EMAILS).toEqual([]);
      expect(loadConfig(validEnv({ ADMIN_BOOTSTRAP_EMAILS: " , ," })).ADMIN_BOOTSTRAP_EMAILS).toEqual([]);
    });

    it("空入力: 空文字の GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET は未設定として扱う", () => {
      const config = loadConfig(validEnv({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }));
      expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
      expect(config.GOOGLE_CLIENT_SECRET).toBeUndefined();
    });

    it("開発では Google の ID とシークレットが無くても起動できる", () => {
      expect(() => loadConfig(validEnv({ NODE_ENV: "development" }))).not.toThrow();
    });

    it("NODE_ENV=production で両方あれば通り、シークレットの値はそのまま保持する", () => {
      const config = loadConfig(
        validEnv({ NODE_ENV: "production", GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gsecret" }),
      );
      expect(config.GOOGLE_CLIENT_SECRET).toBe("gsecret");
    });
  });

  describe("異常系", () => {
    it("入力: http・https 以外の BETTER_AUTH_URL を拒否する", () => {
      const text = expectExit(() => loadConfig(validEnv({ BETTER_AUTH_URL: "ftp://auth.comegin.com" })));
      expect(text).toContain("BETTER_AUTH_URL");
    });

    it.each(["not a url", "auth.comegin.com"])("入力: URL として読めない BETTER_AUTH_URL（%j）も、変数名と理由だけを出して終了する", (value) => {
      const text = expectExit(() => loadConfig(validEnv({ BETTER_AUTH_URL: value })));
      expect(text).toContain("BETTER_AUTH_URL");
      expect(text).toContain("http または https の URL にしてください");
      expect(text).not.toContain(value);
    });

    it("空入力: 空文字の BETTER_AUTH_URL も、変数名と理由だけを出して終了する", () => {
      const text = expectExit(() => loadConfig(validEnv({ BETTER_AUTH_URL: "" })));
      expect(text).toContain("BETTER_AUTH_URL");
      expect(text).toContain("http または https の URL にしてください");
    });

    it("入力: BETTER_AUTH_SECRET が 32 文字未満なら、変数名と理由だけを出して値は出さずに終了する", () => {
      const short = "short-secret-value";
      const text = expectExit(() => loadConfig(validEnv({ BETTER_AUTH_SECRET: short })));
      expect(text).toContain("BETTER_AUTH_SECRET");
      expect(text).toContain("32 文字以上");
      expect(text).not.toContain(short);
    });

    it("入力: ほかの変数の誤りを報告するときも、シークレットの値を出さない", () => {
      const text = expectExit(() => loadConfig(validEnv({ DATABASE_HOST: "", PORT: "70000" })));
      expect(text).toContain("DATABASE_HOST");
      expect(text).toContain("PORT");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(DB_PASSWORD);
    });

    it("空入力: 環境変数が 1 つも無いときは、必須の変数名を列挙して終了する", () => {
      const text = expectExit(() => loadConfig({}));
      for (const key of ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "DATABASE_HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD"]) {
        expect(text).toContain(key);
      }
    });

    it("空入力: 空文字の DATABASE_PASSWORD は未設定と同じく拒否する", () => {
      expect(expectExit(() => loadConfig(validEnv({ DATABASE_PASSWORD: "" })))).toContain("DATABASE_PASSWORD");
    });

    it("入力: DATABASE_SSL に true・false 以外を書くと拒否する", () => {
      expect(expectExit(() => loadConfig(validEnv({ DATABASE_SSL: "yes" })))).toContain("DATABASE_SSL");
    });

    it("入力: PORT の範囲外（0）を拒否する", () => {
      expect(expectExit(() => loadConfig(validEnv({ PORT: "0" })))).toContain("PORT");
    });

    it("入力: GOOGLE_HOSTED_DOMAIN に大文字を含むドメイン名は書けない", () => {
      expect(expectExit(() => loadConfig(validEnv({ GOOGLE_HOSTED_DOMAIN: "Comegin.com" })))).toContain("GOOGLE_HOSTED_DOMAIN");
    });

    it("入力: GOOGLE_HOSTED_DOMAIN にトップレベルだけ（ドットなし）は書けない", () => {
      expect(expectExit(() => loadConfig(validEnv({ GOOGLE_HOSTED_DOMAIN: "localhost" })))).toContain("GOOGLE_HOSTED_DOMAIN");
    });

    it("入力: ADMIN_BOOTSTRAP_EMAILS にメールの形式でない要素があれば拒否し、その要素を出さない", () => {
      const text = expectExit(() => loadConfig(validEnv({ ADMIN_BOOTSTRAP_EMAILS: "a@comegin.com,not-an-email-xyz" })));
      expect(text).toContain("ADMIN_BOOTSTRAP_EMAILS");
      expect(text).not.toContain("not-an-email-xyz");
    });

    it("入力: NODE_ENV=production では Google の ID とシークレットを必須にする", () => {
      const text = expectExit(() => loadConfig(validEnv({ NODE_ENV: "production", GOOGLE_CLIENT_ID: "" })));
      expect(text).toContain("GOOGLE_CLIENT_ID");
      expect(text).toContain("GOOGLE_CLIENT_SECRET");
    });

    it("入力: 想定外の NODE_ENV を拒否する", () => {
      expect(expectExit(() => loadConfig(validEnv({ NODE_ENV: "staging" })))).toContain("NODE_ENV");
    });
  });
});

describe("loadAlbConfig", () => {
  const albEnv = (overrides: Record<string, string> = {}) => ({
    ALB_CLIENT_ID: "alb-admin_gate",
    ALB_CLIENT_SECRET: "alb-secret-0123456789abcdefghijklmnopq",
    ALB_PROTECTED_HOSTS: "mautic.comegin.com",
    ...overrides,
  });

  describe("正常系", () => {
    it("ホスト名は前後の空白を除いて小文字にし、空の要素を捨てる", () => {
      const config = loadAlbConfig(albEnv({ ALB_PROTECTED_HOSTS: " Mautic.Comegin.com, ,n8n.comegin.com " }));
      expect(config.ALB_PROTECTED_HOSTS).toEqual(["mautic.comegin.com", "n8n.comegin.com"]);
    });

    it("ID・シークレットはそのまま保持する", () => {
      const config = loadAlbConfig(albEnv());
      expect(config.ALB_CLIENT_ID).toBe("alb-admin_gate");
      expect(config.ALB_CLIENT_SECRET).toBe("alb-secret-0123456789abcdefghijklmnopq");
    });
  });

  describe("異常系", () => {
    it("入力: スキームやパスの付いたホストを拒否する", () => {
      expect(expectExit(() => loadAlbConfig(albEnv({ ALB_PROTECTED_HOSTS: "https://mautic.comegin.com" })))).toContain(
        "ALB_PROTECTED_HOSTS",
      );
      expect(expectExit(() => loadAlbConfig(albEnv({ ALB_PROTECTED_HOSTS: "mautic.comegin.com/x" })))).toContain(
        "ALB_PROTECTED_HOSTS",
      );
    });

    it("空入力: ホストが 1 つも無ければ（空白とカンマだけ）拒否する", () => {
      expect(expectExit(() => loadAlbConfig(albEnv({ ALB_PROTECTED_HOSTS: " , " })))).toContain("1 つ以上");
    });

    it("空入力: ALB の変数が 1 つも無いときは、3 つの変数名を列挙して終了する", () => {
      const text = expectExit(() => loadAlbConfig({}));
      for (const key of ["ALB_CLIENT_ID", "ALB_CLIENT_SECRET", "ALB_PROTECTED_HOSTS"]) expect(text).toContain(key);
    });

    it("入力: ALB_CLIENT_ID は 8 文字以上の英数字と _ - だけ", () => {
      expect(expectExit(() => loadAlbConfig(albEnv({ ALB_CLIENT_ID: "short" })))).toContain("ALB_CLIENT_ID");
      expect(expectExit(() => loadAlbConfig(albEnv({ ALB_CLIENT_ID: "has space id" })))).toContain("ALB_CLIENT_ID");
    });

    it("入力: ALB_CLIENT_SECRET が短いときは、値を出さずに終了する", () => {
      const short = "alb-short-secret";
      const text = expectExit(() => loadAlbConfig(albEnv({ ALB_CLIENT_SECRET: short })));
      expect(text).toContain("ALB_CLIENT_SECRET");
      expect(text).not.toContain(short);
    });
  });
});

// Lambda の入口が使う。プロセスを終了させず、例外にする（初期化の失敗として次の呼び出しでやり直すため）
describe("parseConfig", () => {
  describe("正常系", () => {
    it("正しい環境変数なら loadConfig と同じ設定を返し、何も出さない", () => {
      const stderr = captureStderr();
      expect(parseConfig(validEnv())).toEqual(loadConfig(validEnv()));
      expect(stderr.spy).not.toHaveBeenCalled();
    });

    it("requireGoogle: false なら、NODE_ENV=production でも Google の設定を求めない（運用の入口）", () => {
      const config = parseConfig(validEnv({ NODE_ENV: "production" }), { requireGoogle: false });
      expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("入力: NODE_ENV=production で Google の設定が無ければ、既定では ConfigError", () => {
      expect(() => parseConfig(validEnv({ NODE_ENV: "production" }))).toThrow(ConfigError);
    });

    it("空入力: 環境変数が 1 つも無ければ、必須の名前を並べた ConfigError を投げ、終了しない", () => {
      const exit = mockExit();
      let error: unknown;
      try {
        parseConfig({});
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigError);
      for (const name of ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "DATABASE_HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD"]) {
        expect((error as Error).message).toContain(`- ${name}:`);
      }
      expect(exit).not.toHaveBeenCalled();
    });

    it("入力: 例外のメッセージに値（シークレット・DB のパスワード）を入れない", () => {
      let message = "";
      try {
        parseConfig(validEnv({ BETTER_AUTH_SECRET: "short", DATABASE_PORT: DB_PASSWORD }));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("BETTER_AUTH_SECRET");
      expect(message).not.toContain(DB_PASSWORD);
      expect(message).not.toContain(SECRET);
    });
  });
});

describe("parseAlbConfig", () => {
  const albEnv = { ALB_CLIENT_ID: "alb-admin-gate", ALB_CLIENT_SECRET: "alb-secret-0123456789abcdefghijklmnopq", ALB_PROTECTED_HOSTS: "Chat.comegin.com" };

  describe("正常系", () => {
    it("正しければ loadAlbConfig と同じ値を返す", () => {
      expect(parseAlbConfig(albEnv)).toEqual(loadAlbConfig(albEnv));
    });
  });

  describe("異常系", () => {
    it("空入力: 何も無ければ ConfigError を投げ、終了しない", () => {
      const exit = mockExit();
      expect(() => parseAlbConfig({})).toThrow(ConfigError);
      expect(exit).not.toHaveBeenCalled();
    });

    it("入力: シークレットが短くても、値をメッセージに入れない", () => {
      let message = "";
      try {
        parseAlbConfig({ ...albEnv, ALB_CLIENT_SECRET: "short-secret-value" });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("ALB_CLIENT_SECRET");
      expect(message).not.toContain("short-secret-value");
    });
  });
});
