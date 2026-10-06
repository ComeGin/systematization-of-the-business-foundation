import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCoreWithTempHome, makeTempDir, removeTempDir } from "../helpers/temp-home.mjs";

const NODE = process.execPath;
// 子プロセスの node の起動は環境によって 1 秒近くかかるので、既定の 5 秒より長く待つ
vi.setConfig({ testTimeout: 20_000 });
const mode = (path) => statSync(path).mode & 0o777;

let home;
let core;
const extraDirs = [];

beforeEach(async () => {
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
  it("W は MarketingDepartment/WebsiteOperations、REPO はその 2 つ上を指す", () => {
    expect(core.W.endsWith(join("MarketingDepartment", "WebsiteOperations"))).toBe(true);
    expect(join(core.REPO, "MarketingDepartment", "WebsiteOperations")).toBe(core.W);
  });

  it("CONFIG_DIR は import した時点の HOME の下の .config/comegin になる", () => {
    expect(core.CONFIG_DIR).toBe(join(home, ".config/comegin"));
  });
});

describe("registerSecret と mask", () => {
  it("登録した秘密値を、すべての出現箇所で [伏せ字] に置き換える", () => {
    core.registerSecret("s3cr3t-value");
    expect(core.mask("a=s3cr3t-value b=s3cr3t-value")).toBe("a=[伏せ字] b=[伏せ字]");
  });

  it("6 文字未満の値は登録しない（短い語で普通の文を壊さないため）", () => {
    core.registerSecret("abcde");
    expect(core.mask("abcde")).toBe("abcde");
  });

  it("ちょうど 6 文字の値は登録する", () => {
    core.registerSecret("abcdef");
    expect(core.mask("xabcdefx")).toBe("x[伏せ字]x");
  });

  it("文字列でない値は登録しない", () => {
    core.registerSecret(12345678);
    core.registerSecret(undefined);
    core.registerSecret(null);
    expect(core.mask("12345678")).toBe("12345678");
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

  it.todo(
    "不具合候補: 短い秘密値が長い秘密値の先頭部分と一致し、短いほうが先に登録されていると、長いほうの残りの文字が伏せられずに出る（lib/core.mjs:42-46。例: abcdef を登録後に abcdefgh を登録 → mask('abcdefgh') が '[伏せ字]gh'）",
  );
});

describe("parseKeyValue", () => {
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

  it("片側だけの引用符や、種類の違う引用符は外さない", () => {
    expect(core.parseKeyValue(`A="x\nB='y"\nC=z'`)).toEqual({ A: '"x', B: `'y"`, C: "z'" });
  });

  it("= が無い行と、= で始まる（キーが空の）行は無視する", () => {
    expect(core.parseKeyValue("NOEQUAL\n=value\nOK=1")).toEqual({ OK: "1" });
  });

  it("値の途中の # はコメントとして扱わない", () => {
    expect(core.parseKeyValue("A=x # y")).toEqual({ A: "x # y" });
  });

  it("空の値は空文字として残す", () => {
    expect(core.parseKeyValue("EMPTY=")).toEqual({ EMPTY: "" });
  });

  it("同じキーが 2 回あれば後の値が勝つ", () => {
    expect(core.parseKeyValue("A=1\nA=2")).toEqual({ A: "2" });
  });
});

describe("loadConfig", () => {
  it("ファイルが無ければ空の設定と、既定の場所（CONFIG_DIR/setup/<target>.conf）を返す", () => {
    const r = core.loadConfig("dev");
    expect(r).toEqual({ file: join(home, ".config/comegin/setup/dev.conf"), conf: {} });
  });

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

  it("ほかのユーザーも読めるファイルは警告する（値は出さない）", () => {
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

  it("600 のファイルでは警告しない", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = join(tempDir(), "closed.conf");
    writeFileSync(file, "A=1\n", { mode: 0o600 });
    core.loadConfig("dev", file);
    expect(err).not.toHaveBeenCalled();
  });
});

describe("State", () => {
  const stateDir = () => join(core.CONFIG_DIR, "setup");

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

  it("has は未定義と空文字を「無い」とみなす", () => {
    const s = new core.State("dev");
    s.set("EMPTY", "");
    s.set("ZERO", 0);
    expect(s.has("MISSING")).toBe(false);
    expect(s.has("EMPTY")).toBe(false);
    expect(s.has("ZERO")).toBe(true);
  });

  it("target ごとに別の状態ファイルを持つ", () => {
    new core.State("dev").set("A", "dev");
    new core.State("prod").set("A", "prod");
    expect(new core.State("dev").get("A")).toBe("dev");
    expect(new core.State("prod").get("A")).toBe("prod");
  });
});

describe("readEnvFile と writeEnvFile", () => {
  it("ファイルが無ければ readEnvFile は空のオブジェクトを返す", () => {
    expect(core.readEnvFile(join(tempDir(), "none.env"))).toEqual({});
  });

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

  it("undefined と null の値は書かない", () => {
    const path = join(tempDir(), ".env");
    writeFileSync(path, "A=\n");
    expect(core.writeEnvFile(path, { A: undefined, B: null })).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("A=\n");
  });
});

describe("randomSecret", () => {
  it("base64url の文字だけで、既定 32 バイト（43 文字）になる", () => {
    const s = core.randomSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("呼ぶたびに違う値を返す", () => {
    expect(core.randomSecret(16)).not.toBe(core.randomSecret(16));
  });
});

describe("http", () => {
  it("json を渡すと Content-Type を付けて本文を JSON にし、応答の JSON を返す", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(core.http("ラベル", "http://127.0.0.1:1/x", { method: "POST", json: { a: 1 } })).resolves.toEqual({ ok: 1 });
    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe('{"a":1}');
    expect(init.redirect).toBe("manual");
  });

  it("form を渡すと x-www-form-urlencoded で送る", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(core.http("ラベル", "http://127.0.0.1:1/x", { method: "POST", form: { a: "1 2" } })).resolves.toBeNull();
    expect(fetch.mock.calls[0][1].body).toBe("a=1+2");
  });

  it("失敗の応答は HTTP の状態と理由を載せた例外にし、理由の中の秘密値は伏せる", async () => {
    core.registerSecret("leaked-token-1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "bad leaked-token-1" }), { status: 401 })));
    const err = await core.http("Chatwoot", "http://127.0.0.1:1/x").catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.message).toBe("Chatwoot: HTTP 401（bad [伏せ字]）");
    expect(err.body).toEqual({ message: "bad leaked-token-1" });
  });

  it("接続できないときは status 0 の例外にし、URL はオリジンだけを出す（パスやクエリを出さない）", async () => {
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

  it("raw: true なら Response をそのまま返す", async () => {
    const res = new Response("x", { status: 302 });
    vi.stubGlobal("fetch", vi.fn(async () => res));
    await expect(core.http("x", "http://127.0.0.1:1/", { raw: true })).resolves.toBe(res);
  });
});

describe("waitForHttp", () => {
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

  it("期限までに応答が無ければ false を返す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    await expect(core.waitForHttp("http://127.0.0.1:1/", { timeoutMs: 30, intervalMs: 5 })).resolves.toBe(false);
  });
});

describe("run（子プロセス）", () => {
  it("成功したら標準出力と標準エラーをまとめて返す", async () => {
    const out = await core.run(NODE, ["-e", "process.stdout.write('out;'); process.stderr.write('err;')"]);
    expect(out).toContain("out;");
    expect(out).toContain("err;");
  });

  it("input を標準入力に渡す（秘密値を引数に載せないため）", async () => {
    const out = await core.run(NODE, ["-e", "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))"], { input: "abc" });
    expect(out).toBe("ABC");
  });

  it("env を親の環境変数に足して渡す", async () => {
    vi.stubEnv("COMEGIN_TEST_PARENT", "p");
    const out = await core.run(NODE, ["-e", "process.stdout.write(process.env.COMEGIN_TEST_PARENT + process.env.COMEGIN_TEST_CHILD)"], { env: { COMEGIN_TEST_CHILD: "c" } });
    expect(out).toBe("pc");
  });

  it("inheritEnv: false なら親の環境変数を渡さない", async () => {
    vi.stubEnv("COMEGIN_TEST_PARENT", "p");
    const out = await core.run(NODE, ["-e", "process.stdout.write(String(process.env.COMEGIN_TEST_PARENT))"], { inheritEnv: false, env: {} });
    expect(out).toBe("undefined");
  });

  it("cwd を子プロセスの作業ディレクトリにする（既定は W）", async () => {
    const dir = tempDir();
    expect(await core.run(NODE, ["-e", "process.stdout.write(process.cwd())"], { cwd: dir })).toBe(dir);
    expect(await core.run(NODE, ["-e", "process.stdout.write(process.cwd())"])).toBe(core.W);
  });

  it("失敗したら終了コードと、出力の最後の 20 行だけを例外に入れる", async () => {
    const script = "for (let i = 1; i <= 25; i++) console.log('line-' + i); process.exit(3)";
    const err = await core.run(NODE, ["-e", script]).catch((e) => e);
    expect(err.message).toContain("終了コード 3");
    const lines = err.message.split("\n").slice(1);
    expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => `line-${i + 6}`));
  });

  it("失敗したときの出力に含まれる登録済みの秘密値を伏せる", async () => {
    core.registerSecret("child-secret-xyz");
    // 秘密値は引数ではなく環境変数で渡す（README の方針どおり）
    const err = await core.run(NODE, ["-e", "console.log('token=' + process.env.S); process.exit(1)"], { env: { S: "child-secret-xyz" } }).catch((e) => e);
    expect(err.message).toContain("token=[伏せ字]");
    expect(err.message).not.toContain("child-secret-xyz");
  });

  it("起動できないコマンドは、理由を添えて失敗する", async () => {
    const err = await core.run("comegin-no-such-command-xyz", []).catch((e) => e);
    expect(err.message).toBe("comegin-no-such-command-xyz を起動できない（ENOENT）");
  });

  it("timeoutMs を過ぎたら子プロセスを止めて失敗にする", async () => {
    const err = await core.run(NODE, ["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("が失敗した");
  });
});

describe("commandExists", () => {
  it("PATH にあるコマンドは true、無いコマンドは false", async () => {
    await expect(core.commandExists("sh")).resolves.toBe(true);
    await expect(core.commandExists("comegin-no-such-command-xyz")).resolves.toBe(false);
  });
});

describe("ManualStepRequired", () => {
  it("Error の一種で、id・題名（message）・手順を持つ", () => {
    const e = new core.ManualStepRequired("mautic:api", "API 資格情報を作る", ["1 つ目", "2 つ目"]);
    expect(e).toBeInstanceOf(Error);
    expect(e.id).toBe("mautic:api");
    expect(e.message).toBe("API 資格情報を作る");
    expect(e.steps).toEqual(["1 つ目", "2 つ目"]);
  });
});

describe("createContext", () => {
  const make = (conf = {}) => {
    const state = new core.State("dev");
    return { state, ctx: core.createContext({ target: "dev", conf, state, moduleId: "chatwoot" }) };
  };

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

  it("ctx.require は値があれば返し、無ければキー名と書く場所を添えて止める", () => {
    const { ctx } = make({ ADMIN_EMAIL: "a@example.com" });
    expect(ctx.require("ADMIN_EMAIL")).toBe("a@example.com");
    expect(() => ctx.require("MAUTIC_CLIENT_ID")).toThrow("MAUTIC_CLIENT_ID が無い。~/.config/comegin/setup/dev.conf に書く");
    expect(() => ctx.require("X", "先に mautic を実行する")).toThrow("X が無い。先に mautic を実行する");
  });

  it("ctx.manual はモジュールの id を前に付けた ManualStepRequired を投げる", () => {
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

  it("ctx.run の失敗の出力でも、状態に置いた秘密値を伏せる", async () => {
    const { ctx, state } = make();
    state.set("N8N_DEV_TOKEN", "n8n-dev-token-1", { secret: true });
    const err = await ctx.run(NODE, ["-e", "console.log(process.env.T); process.exit(2)"], { env: { T: "n8n-dev-token-1" } }).catch((e) => e);
    expect(err.message).toContain("[伏せ字]");
    expect(err.message).not.toContain("n8n-dev-token-1");
  });
});
