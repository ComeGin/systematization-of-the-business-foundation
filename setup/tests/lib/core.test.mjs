// lib/core.mjs（setup の共通部品）の単体テスト。
// 基準 D の例外: core の本質はファイル（設定・状態・環境変数ファイル）の読み書きと権限なので、実際のファイルを一時ディレクトリ
// （tests/helpers/temp-home.mjs。HOME も一時ディレクトリに向ける）で読み書きして確かめる。実際の ~/.config/comegin には書かない。
// 子プロセス（node:child_process の spawn）と fetch は偽物に差し替える（docker などを起動しない・ネットワークに出ない）。
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCoreWithTempHome, makeTempDir, removeTempDir } from "../helpers/temp-home.mjs";

// spawn の偽物。restoreMocks: true で vi.fn の実装が消えるため、素の関数にして、呼び出しと振る舞いは vi.hoisted の状態に置く。
// plan: { stdout, stderr, code } で終わる・{ error } で起動に失敗する・{ hang: true } で終わらない（kill されると close する）
const proc = vi.hoisted(() => ({ calls: [], plan: { stdout: "", stderr: "", code: 0 } }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    ...actual,
    spawn: (cmd, args, opts) => {
      const child = new Emitter();
      child.stdout = new Emitter();
      child.stderr = new Emitter();
      const call = { cmd, args, opts, stdin: [], stdinEnded: false, killed: [] };
      child.stdin = {
        end: (data) => {
          if (data !== undefined) call.stdin.push(String(data));
          call.stdinEnded = true;
        },
      };
      child.kill = (signal) => {
        call.killed.push(signal);
        setImmediate(() => child.emit("close", null, signal));
        return true;
      };
      proc.calls.push(call);
      const plan = typeof proc.plan === "function" ? proc.plan(call) : proc.plan;
      setImmediate(() => {
        if (plan.error) return child.emit("error", plan.error);
        if (plan.hang) return;
        if (plan.stdout) child.stdout.emit("data", Buffer.from(plan.stdout));
        if (plan.stderr) child.stderr.emit("data", Buffer.from(plan.stderr));
        child.emit("close", plan.code ?? 0, null);
      });
      return child;
    },
  };
});

const mode = (path) => statSync(path).mode & 0o777;

let home;
let core;
const extraDirs = [];

beforeEach(async () => {
  proc.calls.length = 0;
  proc.plan = { stdout: "", stderr: "", code: 0 };
  ({ home, core } = await importCoreWithTempHome());
});

afterEach(() => {
  removeTempDir(home);
  while (extraDirs.length) removeTempDir(extraDirs.pop());
});

function tempDir() {
  const d = makeTempDir();
  extraDirs.push(d);
  return d;
}

describe("パスの定数", () => {
  describe("正常系", () => {
    it("W と REPO はどちらもリポジトリのルート（setup の 1 つ上）を指す", () => {
      expect(existsSync(join(core.W, "setup", "setup.mjs"))).toBe(true);
      expect(core.REPO).toBe(core.W);
    });

    it("CONFIG_DIR は import した時点の HOME の下の .config/comegin になる", () => {
      expect(core.CONFIG_DIR).toBe(join(home, ".config/comegin"));
    });
  });
});

describe("registerSecret と mask", () => {
  describe("正常系", () => {
    it("登録した秘密値を、すべての出現箇所で [伏せ字] に置き換える", () => {
      core.registerSecret("s3cr3t-value");
      expect(core.mask("a=s3cr3t-value b=s3cr3t-value")).toBe("a=[伏せ字] b=[伏せ字]");
    });

    it("ちょうど 6 文字の値は登録する", () => {
      core.registerSecret("abcdef");
      expect(core.mask("xabcdefx")).toBe("x[伏せ字]x");
    });

    it("正規表現の特殊文字を含む値も、文字どおりに伏せる", () => {
      core.registerSecret("a.b*c+d?");
      expect(core.mask("[a.b*c+d?] axbxcxd")).toBe("[[伏せ字]] axbxcxd");
    });

    it("文字列以外を渡しても文字列にしてから伏せる", () => {
      core.registerSecret("999999");
      expect(core.mask(1999999)).toBe("1[伏せ字]");
      expect(core.mask(undefined)).toBe("undefined");
    });

    it("空入力: 空文字を伏せても空文字のまま", () => {
      core.registerSecret("secret-zzz");
      expect(core.mask("")).toBe("");
    });
  });

  describe("異常系", () => {
    it("入力: 6 文字未満の値は登録しない（短い語で普通の文を壊さないため）", () => {
      core.registerSecret("abcde");
      expect(core.mask("abcde")).toBe("abcde");
    });

    it("入力: 文字列でない値は登録しない", () => {
      core.registerSecret(12345678);
      core.registerSecret(undefined);
      core.registerSecret(null);
      expect(core.mask("12345678")).toBe("12345678");
    });

    it("空入力: 空文字は登録しない（すべての文字の間に [伏せ字] を入れない）", () => {
      core.registerSecret("");
      expect(core.mask("abc")).toBe("abc");
    });

    // mask は長い値から伏せる（以前は登録順で、短いほうが先だと '[伏せ字]gh' のように長いほうの残りが出た）
    it("入力: 短い秘密値が長い秘密値の一部で、短いほうが先に登録されていても、長いほうを残さず伏せる", () => {
      core.registerSecret("abcdef");
      core.registerSecret("abcdefgh");
      expect(core.mask("abcdefgh")).toBe("[伏せ字]");
      expect(core.mask("x abcdef y")).toBe("x [伏せ字] y");
    });
  });
});

describe("parseKeyValue", () => {
  describe("正常系", () => {
    it("空行と # で始まる行（前に空白があっても）を読み飛ばす", () => {
      expect(core.parseKeyValue("\n# A=1\n   # B=2\n\nC=3\n")).toEqual({ C: "3" });
    });

    it("CRLF の改行も行として分ける", () => {
      expect(core.parseKeyValue("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
    });

    it("最初の = でだけ分け、値の中の = は残す", () => {
      expect(core.parseKeyValue("URL=http://x/?a=b&c=d")).toEqual({ URL: "http://x/?a=b&c=d" });
    });

    it("キーと値の前後の空白を除く", () => {
      expect(core.parseKeyValue("  KEY  =  value  ")).toEqual({ KEY: "value" });
    });

    it("値全体を囲む二重引用符・一重引用符を外す", () => {
      expect(core.parseKeyValue(`A="x y"\nB='z w'`)).toEqual({ A: "x y", B: "z w" });
    });

    it("値の途中の # はコメントとして扱わない", () => {
      expect(core.parseKeyValue("A=x # y")).toEqual({ A: "x # y" });
    });

    it("同じキーが 2 回あれば後の値が勝つ", () => {
      expect(core.parseKeyValue("A=1\nA=2")).toEqual({ A: "2" });
    });

    it("空入力: 空の値は空文字として残す", () => {
      expect(core.parseKeyValue("EMPTY=")).toEqual({ EMPTY: "" });
    });

    it("空入力: 空文字・コメントだけのテキストは空のオブジェクトになる", () => {
      expect(core.parseKeyValue("")).toEqual({});
      expect(core.parseKeyValue("# だけ\n\n")).toEqual({});
    });
  });

  describe("異常系", () => {
    it("入力: 片側だけの引用符や、種類の違う引用符は外さない", () => {
      expect(core.parseKeyValue(`A="x\nB='y"\nC=z'`)).toEqual({ A: '"x', B: `'y"`, C: "z'" });
    });

    it("入力: = が無い行と、= で始まる（キーが空の）行は無視する", () => {
      expect(core.parseKeyValue("NOEQUAL\n=value\nOK=1")).toEqual({ OK: "1" });
    });
  });
});

describe("loadConfig", () => {
  describe("正常系", () => {
    it("既定の場所の設定ファイルを読む", () => {
      const dir = join(core.CONFIG_DIR, "setup");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "dev.conf"), "ADMIN_EMAIL=a@example.com\n", { mode: 0o600 });
      expect(core.loadConfig("dev").conf).toEqual({ ADMIN_EMAIL: "a@example.com" });
    });

    it("path を渡すとその場所を読む", () => {
      const file = join(tempDir(), "custom.conf");
      writeFileSync(file, "X=1\n", { mode: 0o600 });
      expect(core.loadConfig("prod", file)).toEqual({ file, conf: { X: "1" } });
    });

    it("キー名に SECRET・PASSWORD・TOKEN・KEY を含む値（大文字小文字を問わない）を秘密値として登録する", () => {
      const file = join(tempDir(), "s.conf");
      writeFileSync(
        file,
        ["MAUTIC_CLIENT_SECRET=secret-111111", "ADMIN_password=passwd-222222", "API_TOKEN=token-333333", "N8N_API_KEY=apikey-444444", "ADMIN_EMAIL=admin@example.com"].join("\n"),
        { mode: 0o600 },
      );
      core.loadConfig("dev", file);
      expect(core.mask("secret-111111 passwd-222222 token-333333 apikey-444444")).toBe("[伏せ字] [伏せ字] [伏せ字] [伏せ字]");
      expect(core.mask("admin@example.com")).toBe("admin@example.com");
    });

    it("600 のファイルでは警告しない", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const file = join(tempDir(), "closed.conf");
      writeFileSync(file, "A=1\n", { mode: 0o600 });
      core.loadConfig("dev", file);
      expect(err).not.toHaveBeenCalled();
    });

    it("空入力: ファイルが無ければ空の設定と、既定の場所（CONFIG_DIR/setup/<target>.conf）を返す", () => {
      const r = core.loadConfig("dev");
      expect(r).toEqual({ file: join(home, ".config/comegin/setup/dev.conf"), conf: {} });
    });

    it("空入力: 中身が空のファイルは空の設定になる", () => {
      const file = join(tempDir(), "empty.conf");
      writeFileSync(file, "", { mode: 0o600 });
      expect(core.loadConfig("dev", file).conf).toEqual({});
    });
  });

  describe("異常系", () => {
    it("入力: 明示した場所（--config）にファイルが無ければ、空の設定で進まずに例外にする", () => {
      const file = join(tempDir(), "no-such.conf");
      expect(() => core.loadConfig("dev", file)).toThrow(`--config の ${file} が無い`);
    });

    it("入力: ほかのユーザーも読めるファイルは警告する（値は出さない）", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const file = join(tempDir(), "open.conf");
      writeFileSync(file, "SOME_TOKEN=very-secret-value\n");
      // umask に左右されないように明示的に 644 にする
      chmodSync(file, 0o644);
      core.loadConfig("dev", file);
      expect(err).toHaveBeenCalledTimes(1);
      expect(err.mock.calls[0][0]).toContain("chmod 600");
      expect(err.mock.calls[0][0]).not.toContain("very-secret-value");
    });

    it("空入力: 秘密らしい名前のキーでも、6 文字未満・空の値は伏せ字の対象にしない", () => {
      const file = join(tempDir(), "short.conf");
      writeFileSync(file, "A_TOKEN=\nB_KEY=abc\n", { mode: 0o600 });
      core.loadConfig("dev", file);
      expect(core.mask("abc")).toBe("abc");
    });
  });
});

describe("State", () => {
  const stateDir = () => join(core.CONFIG_DIR, "setup");

  describe("正常系", () => {
    it("作るときに CONFIG_DIR/setup を 700 で作り、状態ファイルは <target>.state.json になる", () => {
      const s = new core.State("dev");
      expect(s.file).toBe(join(stateDir(), "dev.state.json"));
      expect(mode(stateDir())).toBe(0o700);
      // 値を書くまではファイルを作らない
      expect(existsSync(s.file)).toBe(false);
    });

    it("set で状態ファイルを 600 で書き、値を読み戻せる", () => {
      const s = new core.State("dev");
      s.set("CHATWOOT_ACCOUNT_ID", 1);
      expect(mode(s.file)).toBe(0o600);
      expect(JSON.parse(readFileSync(s.file, "utf8"))).toEqual({ values: { CHATWOOT_ACCOUNT_ID: 1 }, secrets: [] });
      expect(new core.State("dev").get("CHATWOOT_ACCOUNT_ID")).toBe(1);
    });

    it("既にあるファイルが 644 でも、書いたあとは 600 に直す", () => {
      mkdirSync(stateDir(), { recursive: true });
      const file = join(stateDir(), "dev.state.json");
      writeFileSync(file, JSON.stringify({ values: {}, secrets: [] }));
      chmodSync(file, 0o644);
      new core.State("dev").set("A", "1");
      expect(mode(file)).toBe(0o600);
    });

    it("書き込みは一時ファイルからの rename で行い（ファイルを置き換える）、一時ファイルを残さない", () => {
      const s = new core.State("dev");
      s.set("A", "1");
      const before = statSync(s.file).ino;
      s.set("B", "2");
      // その場で上書きするなら inode は変わらない。rename で置き換えるので変わる
      expect(statSync(s.file).ino).not.toBe(before);
      expect(readdirSync(stateDir())).toEqual(["dev.state.json"]);
    });

    it("secret: true の値は secrets に載り、以後の出力から伏せる", () => {
      const s = new core.State("dev");
      s.set("N8N_API_KEY", "n8n-api-key-value", { secret: true });
      expect(s.isSecret("N8N_API_KEY")).toBe(true);
      expect(core.mask("key=n8n-api-key-value")).toBe("key=[伏せ字]");
    });

    it("secret を付けない値は secrets に載らず、伏せない", () => {
      const s = new core.State("dev");
      s.set("UMAMI_WEBSITE_ID", "website-id-123");
      expect(s.isSecret("UMAMI_WEBSITE_ID")).toBe(false);
      expect(core.mask("website-id-123")).toBe("website-id-123");
    });

    it("同じ秘密のキーを何度 set しても secrets に重複して載らない", () => {
      const s = new core.State("dev");
      s.set("T", "token-aaaaaa", { secret: true });
      s.set("T", "token-bbbbbb", { secret: true });
      expect(JSON.parse(readFileSync(s.file, "utf8")).secrets).toEqual(["T"]);
    });

    it("状態ファイルを読み直すと、記録済みの秘密値を登録し直す（別プロセスでも伏せる）", async () => {
      new core.State("dev").set("STRAPI_DEV_TOKEN", "strapi-token-xyz", { secret: true });
      // モジュールを読み直して、秘密値の登録が空の状態から始める（HOME は同じ一時ディレクトリのまま）
      vi.resetModules();
      const fresh = await import("../../lib/core.mjs");
      expect(fresh.mask("strapi-token-xyz")).toBe("strapi-token-xyz");
      new fresh.State("dev");
      expect(fresh.mask("strapi-token-xyz")).toBe("[伏せ字]");
    });

    it("target ごとに別の状態ファイルを持つ", () => {
      new core.State("dev").set("A", "dev");
      new core.State("prod").set("A", "prod");
      expect(new core.State("dev").get("A")).toBe("dev");
      expect(new core.State("prod").get("A")).toBe("prod");
    });

    it("空入力: has は未定義と空文字を「無い」とみなす", () => {
      const s = new core.State("dev");
      s.set("EMPTY", "");
      s.set("ZERO", 0);
      expect(s.has("MISSING")).toBe(false);
      expect(s.has("EMPTY")).toBe(false);
      expect(s.has("ZERO")).toBe(true);
    });

    it("空入力: 状態ファイルが無ければ、どのキーも undefined で、秘密のキーも無い", () => {
      const s = new core.State("dev");
      expect(s.get("ANY")).toBeUndefined();
      expect(s.isSecret("ANY")).toBe(false);
    });
  });

  describe("異常系", () => {
    it("入力: 状態ファイルが JSON として壊れていれば例外にし、空の状態で上書きしない（作った値を失わない）", () => {
      mkdirSync(stateDir(), { recursive: true });
      const file = join(stateDir(), "dev.state.json");
      writeFileSync(file, "{ broken", { mode: 0o600 });
      expect(() => new core.State("dev")).toThrow(SyntaxError);
      expect(readFileSync(file, "utf8")).toBe("{ broken");
    });
  });
});

describe("readEnvFile と writeEnvFile", () => {
  describe("正常系", () => {
    it("ファイルが無ければ template を写してから書き、600 にする", () => {
      const dir = tempDir();
      const template = join(dir, ".env.example");
      writeFileSync(template, "# コメント\nA=\nB=keep\n");
      const path = join(dir, "sub", ".env");
      const changed = core.writeEnvFile(path, { A: "new" }, { template });
      expect(changed).toEqual(["A"]);
      expect(readFileSync(path, "utf8")).toBe("# コメント\nA=new\nB=keep\n");
      expect(mode(path)).toBe(0o600);
    });

    it("既定（onlyIfEmpty）では、値の入っているキーを書き換えない（暗号化の鍵を守る）", () => {
      const path = join(tempDir(), ".env");
      writeFileSync(path, "N8N_ENCRYPTION_KEY=existing\n");
      expect(core.writeEnvFile(path, { N8N_ENCRYPTION_KEY: "other" })).toEqual([]);
      expect(core.readEnvFile(path)).toEqual({ N8N_ENCRYPTION_KEY: "existing" });
    });

    it("onlyIfEmpty: false なら値の入っているキーも書き換える", () => {
      const path = join(tempDir(), ".env");
      writeFileSync(path, "A=old\n");
      expect(core.writeEnvFile(path, { A: "new" }, { onlyIfEmpty: false })).toEqual(["A"]);
      expect(core.readEnvFile(path)).toEqual({ A: "new" });
    });

    it("コメントアウトされたキーは、その行を有効な行に置き換える", () => {
      const path = join(tempDir(), ".env");
      writeFileSync(path, "# A=example\nB=1\n");
      core.writeEnvFile(path, { A: "v" });
      expect(readFileSync(path, "utf8")).toBe("A=v\nB=1\n");
    });

    it("無いキーは末尾に足し、名前が前方一致するだけのキーとは区別する", () => {
      const path = join(tempDir(), ".env");
      writeFileSync(path, "FOO_BAR=1\n");
      core.writeEnvFile(path, { FOO: "2" });
      expect(core.readEnvFile(path)).toEqual({ FOO_BAR: "1", FOO: "2" });
    });

    it("同じ値なら書き換えたと数えず、ファイルも書き直さない", () => {
      const path = join(tempDir(), ".env");
      writeFileSync(path, "A=same\n");
      const before = statSync(path).mtimeMs;
      expect(core.writeEnvFile(path, { A: "same" }, { onlyIfEmpty: false })).toEqual([]);
      expect(statSync(path).mtimeMs).toBe(before);
    });

    it("CONFIG_DIR の中に書くときは、親のディレクトリを 700 で作る（MCP の env ファイルなど）", () => {
      const path = join(core.CONFIG_DIR, "mcp", "n8n-dev.env");
      core.writeEnvFile(path, { N8N_DEV_TOKEN: "t" }, { onlyIfEmpty: false });
      expect(mode(join(core.CONFIG_DIR, "mcp"))).toBe(0o700);
      expect(mode(path)).toBe(0o600);
    });

    it("CONFIG_DIR の外（リポジトリの中のディレクトリなど）に書くときは、既にあるディレクトリの権限を変えない（ファイルは 600）", () => {
      const dir = tempDir();
      chmodSync(dir, 0o755);
      const path = join(dir, ".env");
      core.writeEnvFile(path, { A: "1" });
      expect(mode(dir)).toBe(0o755);
      expect(mode(path)).toBe(0o600);
    });

    it("空入力: ファイルが無ければ readEnvFile は空のオブジェクトを返す", () => {
      expect(core.readEnvFile(join(tempDir(), "none.env"))).toEqual({});
    });

    it("空入力: 書く値が空（{}）でもファイルが無ければ、空のファイルを 600 で作る", () => {
      const path = join(tempDir(), "new.env");
      expect(core.writeEnvFile(path, {})).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe("\n");
      expect(mode(path)).toBe(0o600);
    });

    it("空入力: undefined と null の値は書かない", () => {
      const path = join(tempDir(), ".env");
      writeFileSync(path, "A=\n");
      expect(core.writeEnvFile(path, { A: undefined, B: null })).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe("A=\n");
    });
  });

  describe("異常系", () => {
    it("入力: CONFIG_DIR と名前の前方だけが同じ別のディレクトリ（~/.config/comegin-other）は、CONFIG_DIR の中とみなさない", () => {
      const sibling = `${core.CONFIG_DIR}-other`;
      mkdirSync(sibling, { recursive: true, mode: 0o755 });
      chmodSync(sibling, 0o755);
      core.writeEnvFile(join(sibling, ".env"), { A: "1" });
      expect(mode(sibling)).toBe(0o755);
    });

    it("入力: template のパスが無いファイルなら、空から書く", () => {
      const dir = tempDir();
      const path = join(dir, ".env");
      expect(core.writeEnvFile(path, { A: "1" }, { template: join(dir, "missing.example") })).toEqual(["A"]);
      expect(readFileSync(path, "utf8")).toBe("\nA=1\n");
    });
  });
});

describe("randomSecret", () => {
  describe("正常系", () => {
    it("base64url の文字だけで、既定 32 バイト（43 文字）になる", () => {
      const s = core.randomSecret();
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("呼ぶたびに違う値を返す", () => {
      expect(core.randomSecret(16)).not.toBe(core.randomSecret(16));
    });

    it("空入力: 0 バイトなら空文字を返す", () => {
      expect(core.randomSecret(0)).toBe("");
    });
  });
});

describe("http", () => {
  describe("正常系", () => {
    it("json を渡すと Content-Type を付けて本文を JSON にし、応答の JSON を返す", async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      await expect(core.http("ラベル", "http://127.0.0.1:1/x", { method: "POST", json: { a: 1 } })).resolves.toEqual({ ok: 1 });
      const [, init] = fetch.mock.calls[0];
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.body).toBe('{"a":1}');
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("form を渡すと x-www-form-urlencoded で送る", async () => {
      const fetch = vi.fn(async () => new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      await expect(core.http("ラベル", "http://127.0.0.1:1/x", { method: "POST", form: { a: "1 2" } })).resolves.toBeNull();
      expect(fetch.mock.calls[0][1].body).toBe("a=1+2");
    });

    it("raw: true なら Response をそのまま返す", async () => {
      const res = new Response("x", { status: 302 });
      vi.stubGlobal("fetch", vi.fn(async () => res));
      await expect(core.http("x", "http://127.0.0.1:1/", { raw: true })).resolves.toBe(res);
    });

    it("空入力: 本文の無い成功（204）は null を返す", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
      await expect(core.http("x", "http://127.0.0.1:1/")).resolves.toBeNull();
    });
  });

  describe("異常系", () => {
    it("サーバ: 失敗の応答は HTTP の状態と理由を載せた例外にし、理由の中の秘密値は伏せる", async () => {
      core.registerSecret("leaked-token-1");
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "bad leaked-token-1" }), { status: 401 })));
      const err = await core.http("Chatwoot", "http://127.0.0.1:1/x").catch((e) => e);
      expect(err.status).toBe(401);
      expect(err.message).toBe("Chatwoot: HTTP 401（bad [伏せ字]）");
      expect(err.body).toEqual({ message: "bad leaked-token-1" });
    });

    it.each([
      [422, { errors: [{ message: "email is invalid" }] }, "x: HTTP 422（email is invalid）"],
      [403, { error: { message: "forbidden scope" } }, "x: HTTP 403（forbidden scope）"],
      [404, { error: "Not Found" }, "x: HTTP 404（Not Found）"],
      [500, { error: { code: 1 } }, "x: HTTP 500"],
    ])("サーバ: %s の応答は、message・error.message・errors[0].message・error（文字列）の順で理由を取る", async (status, body, message) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
      const err = await core.http("x", "http://127.0.0.1:1/").catch((e) => e);
      expect(err.message).toBe(message);
      expect(err.status).toBe(status);
    });

    it("サーバ: JSON でない失敗の応答（HTML の 502）は、HTTP の状態だけを示し、body は null", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad Gateway</html>", { status: 502 })));
      const err = await core.http("Mautic", "http://127.0.0.1:1/").catch((e) => e);
      expect(err.message).toBe("Mautic: HTTP 502");
      expect(err.body).toBeNull();
    });

    it("サーバ: 理由が長すぎれば 300 文字で切る", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "e".repeat(1000) }), { status: 500 })));
      const err = await core.http("x", "http://127.0.0.1:1/").catch((e) => e);
      expect(err.message).toBe(`x: HTTP 500（${"e".repeat(300)}）`);
    });

    it("サーバ: 成功の応答でも JSON でなければ null を返す（例外にしない）", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("OK", { status: 200 })));
      await expect(core.http("x", "http://127.0.0.1:1/")).resolves.toBeNull();
    });

    it("サーバ: 接続できないときは status 0 の例外にし、URL はオリジンだけを出す（パスやクエリを出さない）", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        }),
      );
      const err = await core.http("n8n", "http://127.0.0.1:5678/api/v1/x?token=abc").catch((e) => e);
      expect(err.status).toBe(0);
      expect(err.message).toBe("n8n: http://127.0.0.1:5678 に接続できない（ECONNREFUSED）");
    });

    it("サーバ: タイムアウト（TimeoutError）なら「タイムアウト」と示す", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }),
      );
      const err = await core.http("Strapi", "http://127.0.0.1:1337/admin", { timeoutMs: 1 }).catch((e) => e);
      expect(err.status).toBe(0);
      expect(err.message).toBe("Strapi: http://127.0.0.1:1337 に接続できない（タイムアウト）");
    });
  });
});

describe("waitForHttp", () => {
  describe("正常系", () => {
    it("500 未満の応答が来た時点で true を返す", async () => {
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("down"))
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(new Response("", { status: 404 }));
      vi.stubGlobal("fetch", fetch);
      await expect(core.waitForHttp("http://127.0.0.1:1/", { timeoutMs: 5_000, intervalMs: 1 })).resolves.toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("異常系", () => {
    it("サーバ: 期限までに 5xx しか返らなければ false を返す", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
      await expect(core.waitForHttp("http://127.0.0.1:1/", { timeoutMs: 30, intervalMs: 5 })).resolves.toBe(false);
    });

    it("サーバ: 期限まで接続できなければ（reject し続けても）例外にせず false を返す", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      );
      await expect(core.waitForHttp("http://127.0.0.1:1/", { timeoutMs: 30, intervalMs: 5 })).resolves.toBe(false);
    });

    it("空入力: timeoutMs が 0 なら、一度も問い合わせずに false を返す", async () => {
      const fetch = vi.fn(async () => new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      await expect(core.waitForHttp("http://127.0.0.1:1/", { timeoutMs: 0 })).resolves.toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe("run（子プロセス。spawn は偽物）", () => {
  describe("正常系", () => {
    it("成功したら標準出力と標準エラーをまとめて返す", async () => {
      proc.plan = { stdout: "out;", stderr: "err;", code: 0 };
      const out = await core.run("docker", ["compose", "up", "-d"]);
      expect(out).toBe("out;err;");
      expect(proc.calls[0]).toMatchObject({ cmd: "docker", args: ["compose", "up", "-d"] });
      expect(proc.calls[0].opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
    });

    it("input を標準入力に渡す（秘密値を引数に載せないため）", async () => {
      await core.run("docker", ["login", "--password-stdin"], { input: "abc" });
      expect(proc.calls[0].stdin).toEqual(["abc"]);
      expect(proc.calls[0].args).not.toContain("abc");
    });

    it("env を親の環境変数に足して渡す", async () => {
      vi.stubEnv("COMEGIN_TEST_PARENT", "p");
      await core.run("node", ["x"], { env: { COMEGIN_TEST_CHILD: "c" } });
      expect(proc.calls[0].opts.env).toMatchObject({ COMEGIN_TEST_PARENT: "p", COMEGIN_TEST_CHILD: "c" });
    });

    it("inheritEnv: false なら親の環境変数を渡さない", async () => {
      vi.stubEnv("COMEGIN_TEST_PARENT", "p");
      await core.run("node", ["x"], { inheritEnv: false, env: { ONLY: "1" } });
      expect(proc.calls[0].opts.env).toEqual({ ONLY: "1" });
    });

    it("cwd を子プロセスの作業ディレクトリにする（既定は W）", async () => {
      const dir = tempDir();
      await core.run("node", ["x"], { cwd: dir });
      await core.run("node", ["x"]);
      expect(proc.calls.map((c) => c.opts.cwd)).toEqual([dir, core.W]);
    });

    it("空入力: input が無ければ標準入力を何も書かずに閉じ、出力が無ければ空文字を返す", async () => {
      await expect(core.run("true", [])).resolves.toBe("");
      expect(proc.calls[0].stdin).toEqual([]);
      expect(proc.calls[0].stdinEnded).toBe(true);
    });
  });

  describe("異常系", () => {
    it("サーバ: 失敗したら終了コードと、出力の最後の 20 行だけを例外に入れる", async () => {
      proc.plan = { stdout: `${Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join("\n")}\n`, code: 3 };
      const err = await core.run("docker", ["compose", "up"]).catch((e) => e);
      expect(err.message).toContain("docker compose up が失敗した（終了コード 3）");
      const lines = err.message.split("\n").slice(1);
      expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => `line-${i + 6}`));
    });

    it("サーバ: 失敗したときの出力に含まれる登録済みの秘密値を伏せる", async () => {
      core.registerSecret("child-secret-xyz");
      proc.plan = { stdout: "token=child-secret-xyz\n", code: 1 };
      const err = await core.run("node", ["x"], { env: { S: "child-secret-xyz" } }).catch((e) => e);
      expect(err.message).toContain("token=[伏せ字]");
      expect(err.message).not.toContain("child-secret-xyz");
    });

    it("入力: 起動できないコマンドは、理由を添えて失敗する", async () => {
      proc.plan = { error: Object.assign(new Error("spawn comegin-no-such-command-xyz ENOENT"), { code: "ENOENT" }) };
      const err = await core.run("comegin-no-such-command-xyz", []).catch((e) => e);
      expect(err.message).toBe("comegin-no-such-command-xyz を起動できない（ENOENT）");
    });

    it("サーバ: timeoutMs を過ぎたら子プロセスを SIGTERM で止めて失敗にする", async () => {
      proc.plan = { hang: true };
      const err = await core.run("docker", ["compose", "up"], { timeoutMs: 20 }).catch((e) => e);
      expect(proc.calls[0].killed).toEqual(["SIGTERM"]);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("が失敗した");
    });

    it("空入力: 失敗して出力が無ければ、終了コードだけを示す", async () => {
      proc.plan = { code: 2 };
      const err = await core.run("false", []).catch((e) => e);
      expect(err.message).toBe("false  が失敗した（終了コード 2）\n");
    });
  });
});

describe("commandExists（spawn は偽物）", () => {
  describe("正常系", () => {
    it("sh -c 'command -v <名前>' が 0 で終われば true", async () => {
      await expect(core.commandExists("docker")).resolves.toBe(true);
      expect(proc.calls[0]).toMatchObject({ cmd: "sh", args: ["-c", "command -v docker"] });
    });
  });

  describe("異常系", () => {
    it("入力: PATH に無い（command -v が 1）なら false", async () => {
      proc.plan = { code: 1 };
      await expect(core.commandExists("comegin-no-such-command-xyz")).resolves.toBe(false);
    });

    it("入力: sh 自体を起動できなくても例外にせず false", async () => {
      proc.plan = { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
      await expect(core.commandExists("docker")).resolves.toBe(false);
    });
  });
});

describe("ManualStepRequired", () => {
  describe("正常系", () => {
    it("Error の一種で、id・題名（message）・手順を持つ", () => {
      const e = new core.ManualStepRequired("mautic:api", "API 資格情報を作る", ["1 つ目", "2 つ目"]);
      expect(e).toBeInstanceOf(Error);
      expect(e.id).toBe("mautic:api");
      expect(e.message).toBe("API 資格情報を作る");
      expect(e.steps).toEqual(["1 つ目", "2 つ目"]);
    });
  });
});

describe("createContext", () => {
  const make = (conf = {}) => {
    const state = new core.State("dev");
    return { state, ctx: core.createContext({ target: "dev", conf, state, moduleId: "chatwoot" }) };
  };

  describe("正常系", () => {
    it("モジュールに W・REPO・CONFIG_DIR・target・conf・state と共通の関数を渡す", () => {
      const conf = { A: "1" };
      const { ctx, state } = make(conf);
      expect(ctx).toMatchObject({ target: "dev", conf, state, W: core.W, REPO: core.REPO, CONFIG_DIR: core.CONFIG_DIR });
      for (const fn of ["http", "run", "commandExists", "waitForHttp", "readEnvFile", "writeEnvFile", "randomSecret"]) expect(ctx[fn]).toBe(core[fn]);
    });

    it("ctx.log はモジュールの id を前に付け、秘密値を伏せて標準出力に出す", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { ctx, state } = make();
      state.set("CHATWOOT_ADMIN_TOKEN", "admin-token-abc", { secret: true });
      ctx.log("トークン admin-token-abc を作った");
      expect(log).toHaveBeenCalledWith("  [chatwoot] トークン [伏せ字] を作った");
    });

    it("ctx.warn は ! を付けて、秘密値を伏せて標準エラーに出す", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const { ctx } = make();
      core.registerSecret("warn-secret-1");
      ctx.warn("warn-secret-1 が古い");
      expect(err).toHaveBeenCalledWith("  [chatwoot] ! [伏せ字] が古い");
    });

    it("ctx.value は設定を優先し、無ければ（空文字も含めて）状態の値を返す", () => {
      const { ctx, state } = make({ A: "conf", B: "" });
      state.set("A", "state");
      state.set("B", "state-b");
      state.set("C", "state-c");
      expect(ctx.value("A")).toBe("conf");
      expect(ctx.value("B")).toBe("state-b");
      expect(ctx.value("C")).toBe("state-c");
      expect(ctx.value("D")).toBeUndefined();
    });

    it("ctx.require は値があれば返す", () => {
      const { ctx } = make({ ADMIN_EMAIL: "a@example.com" });
      expect(ctx.require("ADMIN_EMAIL")).toBe("a@example.com");
    });
  });

  describe("異常系", () => {
    it("空入力: ctx.require は値が無ければ、キー名と書く場所を添えて止める", () => {
      const { ctx } = make({ ADMIN_EMAIL: "a@example.com" });
      expect(() => ctx.require("MAUTIC_CLIENT_ID")).toThrow("MAUTIC_CLIENT_ID が無い。~/.config/comegin/setup/dev.conf に書く");
      expect(() => ctx.require("X", "先に mautic を実行する")).toThrow("X が無い。先に mautic を実行する");
    });

    it("空入力: ctx.require は設定・状態の値が空文字でも「無い」として止める", () => {
      const { ctx, state } = make({ E: "" });
      state.set("E", "");
      expect(() => ctx.require("E")).toThrow("E が無い。");
    });

    it("入力: ctx.manual はモジュールの id を前に付けた ManualStepRequired を投げる", () => {
      const { ctx } = make();
      let caught;
      try {
        ctx.manual("admin-password", "パスワードを書く", ["手順"]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(core.ManualStepRequired);
      expect(caught.id).toBe("chatwoot:admin-password");
      expect(caught.message).toBe("パスワードを書く");
      expect(caught.steps).toEqual(["手順"]);
    });

    it("サーバ: ctx.run の失敗の出力でも、状態に置いた秘密値を伏せる", async () => {
      const { ctx, state } = make();
      state.set("N8N_DEV_TOKEN", "n8n-dev-token-1", { secret: true });
      proc.plan = { stdout: "n8n-dev-token-1\n", code: 2 };
      const err = await ctx.run("node", ["x"], { env: { T: "n8n-dev-token-1" } }).catch((e) => e);
      expect(err.message).toContain("[伏せ字]");
      expect(err.message).not.toContain("n8n-dev-token-1");
    });
  });
});

// 偽の spawn が子プロセスらしく振る舞うこと（イベントの順番）の確かめ。偽物が崩れると run のテストが素通りするため
describe("偽の spawn", () => {
  describe("正常系", () => {
    it("data のあとに close を出し、EventEmitter として購読できる", async () => {
      const { spawn } = await import("node:child_process");
      proc.plan = { stdout: "x", code: 0 };
      const child = spawn("x", [], {});
      expect(child).toBeInstanceOf(EventEmitter);
      const events = [];
      child.stdout.on("data", () => events.push("data"));
      await new Promise((r) => child.on("close", (code) => (events.push(`close ${code}`), r())));
      expect(events).toEqual(["data", "close 0"]);
    });
  });
});
