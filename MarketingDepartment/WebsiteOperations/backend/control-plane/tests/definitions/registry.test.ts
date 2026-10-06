import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_REGISTRY_FILE } from "../../src/constants/paths.js";
import { loadMcpRegistry } from "../../src/definitions/registry.js";
import { makeTempDir, putFile, repositoryRoot } from "../helpers/store.js";

let temp: ReturnType<typeof makeTempDir>;

beforeEach(() => {
  temp = makeTempDir();
});
afterEach(() => {
  temp.cleanup();
});

function putRegistry(yaml: string): void {
  putFile(temp.dir, MCP_REGISTRY_FILE, yaml);
}

const STDIO = `
  - name: chatwoot
    env: dev
    transport: stdio
    command: node
    env_vars:
      TRANSPORT: stdio
      CHATWOOT_ACCESS_LEVEL: read_write`;

const HTTP = `
  - name: strapi-prod
    env: prod
    transport: http
    url: https://cms.example.com/mcp
    headers_from_env_file:
      env_file: "\${HOME}/.config/comegin/mcp/strapi-prod.env"
      Authorization: "Bearer \${STRAPI_TOKEN}"`;

describe("loadMcpRegistry", () => {
  it("登録表が無ければ空（エラーにしない）", async () => {
    expect((await loadMcpRegistry(temp.dir)).servers.size).toBe(0);
  });

  it("stdio と http の登録を名前で引けるようにし、args の既定は空配列", async () => {
    putRegistry(`version: 1\nservers:${STDIO}${HTTP}\n`);
    const { servers } = await loadMcpRegistry(temp.dir);
    expect([...servers.keys()]).toEqual(["chatwoot", "strapi-prod"]);
    expect(servers.get("chatwoot")).toMatchObject({ command: "node", args: [], env_vars: { TRANSPORT: "stdio" } });
    expect(servers.get("strapi-prod")?.headers_from_env_file).toEqual({
      env_file: "${HOME}/.config/comegin/mcp/strapi-prod.env",
      Authorization: "Bearer ${STRAPI_TOKEN}",
    });
  });

  it("version が 1 でなければ拒否する", async () => {
    putRegistry(`version: 2\nservers:${STDIO}\n`);
    await expect(loadMcpRegistry(temp.dir)).rejects.toThrow(/mcp-registry.yaml が不正です: version/);
  });

  it("名前の重複を拒否する", async () => {
    putRegistry(`version: 1\nservers:${STDIO}${STDIO}\n`);
    await expect(loadMcpRegistry(temp.dir)).rejects.toThrow(/名前が重複しています: chatwoot/);
  });

  it.each(["has__double", "Upper", "1st", "snake_case"])("name %j は拒否する（mcp__<name>__ を壊す）", async (name) => {
    putRegistry(`version: 1\nservers:\n  - name: ${name}\n    env: dev\n    transport: stdio\n    command: node\n`);
    await expect(loadMcpRegistry(temp.dir)).rejects.toThrow(/servers\.0\.name/);
  });

  it("stdio で command が無ければ拒否する", async () => {
    putRegistry("version: 1\nservers:\n  - name: a\n    env: dev\n    transport: stdio\n");
    await expect(loadMcpRegistry(temp.dir)).rejects.toThrow(/servers\.0\.command: transport=stdio では必須です/);
  });

  it("http で url が無ければ拒否し、env_vars を持たせない", async () => {
    putRegistry("version: 1\nservers:\n  - name: a\n    env: dev\n    transport: http\n    env_vars:\n      TRANSPORT: http\n");
    const error = await loadMcpRegistry(temp.dir).catch((e: Error) => e);
    expect(String(error)).toMatch(/servers\.0\.url: transport=http では必須です/);
    expect(String(error)).toMatch(/servers\.0\.env_vars: env_vars は transport=stdio のときだけ使える/);
  });

  it.each(["MAUTIC_CLIENT_SECRET", "DB_PASSWORD", "API_TOKEN", "ANTHROPIC_API_KEY", "APIKEY", "WEBHOOK_HMAC", "SIGNING_KEY"])(
    "秘密値らしい env_vars のキー %s を拒否し、値はエラー文に出さない",
    async (key) => {
      putRegistry(
        `version: 1\nservers:\n  - name: a\n    env: dev\n    transport: stdio\n    command: node\n    env_vars:\n      ${key}: s3cr3t-value-xyz\n`,
      );
      const error = await loadMcpRegistry(temp.dir).catch((e: Error) => e);
      expect(String(error)).toContain(`${key}: 秘密値は登録表に書かない`);
      expect(String(error)).not.toContain("s3cr3t-value-xyz");
    },
  );

  it("env_vars のキーは環境変数名の形に限る", async () => {
    putRegistry("version: 1\nservers:\n  - name: a\n    env: dev\n    transport: stdio\n    command: node\n    env_vars:\n      BAD-NAME: x\n");
    // zod 4 はレコードのキーの不備を独自文言でなく "Invalid key in record" で返す。パスで確かめる
    await expect(loadMcpRegistry(temp.dir)).rejects.toThrow(/servers\.0\.env_vars\.BAD-NAME/);
  });

  it("env と transport は列挙値だけ", async () => {
    putRegistry("version: 1\nservers:\n  - name: a\n    env: staging\n    transport: sse\n    command: node\n");
    const error = await loadMcpRegistry(temp.dir).catch((e: Error) => e);
    expect(String(error)).toMatch(/servers\.0\.env/);
    expect(String(error)).toMatch(/servers\.0\.transport/);
  });
});

describe("実在の登録表（W/ops/mcp-registry.yaml）", () => {
  const root = repositoryRoot();

  it.skipIf(!root)("検証を通り、少なくとも 1 件の登録がある", async () => {
    const { servers } = await loadMcpRegistry(root!);
    expect(servers.size).toBeGreaterThan(0);
  });
});
