import { describe, expect, it } from "vitest";

import { READ_ONLY_ANNOTATIONS } from "../../src/tools/annotations.js";
import { registerAccountTools } from "../../src/tools/account.js";
import { installFetch, routes, V1 } from "../helpers/fetch.js";
import { createFakeServer, makeCtx, textOf } from "../helpers/server.js";

function setup(accessLevel: "read_only" | "read_write" | "full" = "read_only") {
  const fake = createFakeServer();
  registerAccountTools(fake.server, makeCtx(), accessLevel);
  return fake;
}

const ACCOUNT = { id: 1, name: "ComeGin", locale: "ja", support_email: "support@example.com", custom_attributes: { api_key: "k" } };
const PROFILE = {
  id: 5,
  name: "AI Agent",
  email: "agent@example.com",
  role: "agent",
  accounts: [
    { id: 2, role: "agent", availability_status: "offline" },
    { id: 1, role: "administrator", availability_status: "online" },
  ],
  access_token: "profile-token",
};

describe("chatwoot_get_account", () => {
  it("参照専用の注釈で、どのアクセスレベルでも 1 つだけ登録する", () => {
    for (const level of ["read_only", "read_write", "full"] as const) {
      const fake = setup(level);
      expect(fake.names()).toEqual(["chatwoot_get_account"]);
      expect(fake.tools.get("chatwoot_get_account")!.config.annotations).toEqual(READ_ONLY_ANNOTATIONS);
    }
  });

  it("アカウント（v1）と接続ユーザーのプロフィール（アカウント外の /api/v1/profile）を GET する", async () => {
    const { calls } = installFetch(routes({ [`GET ${V1}`]: { json: ACCOUNT }, "GET /api/v1/profile": { json: PROFILE } }));
    await setup().call("chatwoot_get_account");
    expect(calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual([`GET ${V1}`, "GET /api/v1/profile"]);
  });

  it("このアカウントでのロールとアクセスレベルを返し、秘匿情報を伏せる", async () => {
    installFetch(routes({ [`GET ${V1}`]: { json: ACCOUNT }, "GET /api/v1/profile": { json: PROFILE } }));
    const result = await setup("read_write").call("chatwoot_get_account", { response_format: "json" });
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.access_level).toBe("read_write");
    expect(structured.timezone_offset_hours).toBe(9);
    expect(structured.user).toEqual({ id: 5, name: "AI Agent", email: "agent@example.com", role: "administrator", availability_status: "online" });
    expect(structured.account.custom_attributes).toEqual({ api_key: "[redacted]" });
    expect(textOf(result)).not.toContain("profile-token");
  });

  it("Markdown では見出しにアカウント名とアクセスレベルを出す", async () => {
    installFetch(routes({ [`GET ${V1}`]: { json: ACCOUNT }, "GET /api/v1/profile": { json: PROFILE } }));
    const text = textOf(await setup().call("chatwoot_get_account"));
    expect(text).toContain("# Chatwoot account 1: ComeGin");
    expect(text).toContain("MCP access level: read_only / time zone offset: UTC+9");
  });

  it("404 は CHATWOOT_ACCOUNT_ID を確かめるよう案内する", async () => {
    installFetch(() => ({ status: 404, json: { error: "Resource could not be found" } }));
    const result = await setup().call("chatwoot_get_account");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Check CHATWOOT_ACCOUNT_ID");
  });
});
