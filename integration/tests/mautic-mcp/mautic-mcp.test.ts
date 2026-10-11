import { randomBytes } from "node:crypto";

import { ProtocolError, ProtocolErrorCode, type CallToolResult } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Cleanup } from "../helpers/cleanup.ts";
import { mcpEnv, requireValue } from "../helpers/env.ts";
import { http } from "../helpers/http.ts";
import { deleteContact, mauticApi } from "../helpers/mautic.ts";
import { itEmail, itName, RUN_ID } from "../helpers/run-id.ts";
// chatwoot-mcp と同じ起動の補助を使う（どちらも担当 B のスイート）
import {
  containsAnySecret,
  runUntilExit,
  startHttp,
  startStdio,
  structuredOf,
  textOf,
  type AccessLevel,
  type HttpServerProcess,
  type StdioSession,
} from "../chatwoot-mcp/mcp-server.ts";

/**
 * I-04 エージェント → mautic-mcp → 開発の Mautic（127.0.0.1:8000）。
 *
 * ビルド済みの backend/mautic-mcp/dist/index.js を MCP SDK の Client（stdio）で起動し、本物の Mautic に対してツールを呼ぶ。
 * 登録は ~/.config/comegin/mcp/mautic-dev.env（OAuth2 client_credentials）。mautic-mcp は既定のトランスポートが HTTP なので、
 * stdio の確認では TRANSPORT=stdio を渡す（startStdio が付ける）。
 *
 * - テストで作るデータ（コンタクト・タグ・セグメント・Webhook）は `it-` で始め、作った直後に Cleanup に登録する
 * - Mautic はコンタクトを消してもタグを残すので、RUN_ID で始まるタグは最後にまとめて消す
 * - Webhook は isPublished=false で作る（他の担当の操作で発火させない）
 */

const TOOL_COUNT: Record<AccessLevel, number> = { read_only: 14, read_write: 16, full: 17 };
const WRITE_TOOLS = ["mautic_create_record", "mautic_update_record"];
const DELETE_TOOLS = ["mautic_delete_record"];

const envFor = (level: AccessLevel): Record<string, string> => ({ ...mcpEnv("mautic"), MAUTIC_ACCESS_LEVEL: level });

/** 応答に出てはいけない値（OAuth2 の client_secret） */
const secrets = (): string[] => [mcpEnv("mautic").MAUTIC_CLIENT_SECRET ?? requireValue("MAUTIC_CLIENT_SECRET")];

const call = (session: StdioSession, name: string, args: Record<string, unknown> = {}) =>
  session.client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

function ok(result: CallToolResult, context: string): CallToolResult {
  expect(result.isError, `${context}: ${textOf(result).split("\n")[0]}`).not.toBe(true);
  return result;
}

/** Mautic の REST API で消す（後片付け用。404 は消えているので成功扱い） */
async function deleteVia(path: string): Promise<void> {
  const res = await mauticApi(path, { method: "DELETE" });
  if (res.status !== 200 && res.status !== 404) throw new Error(`DELETE ${path} が HTTP ${res.status}`);
}

/** RUN_ID で始まるタグを全部消す（コンタクトのタグは、コンタクトを消しても残る） */
async function deleteRunTags(): Promise<void> {
  const res = await mauticApi<{ tags?: Record<string, { id: number; tag: string }> | [] }>(`/tags?search=${encodeURIComponent(RUN_ID)}&limit=200`);
  if (res.status !== 200) throw new Error(`タグの検索が HTTP ${res.status}`);
  for (const tag of Object.values(res.json?.tags ?? {})) if (tag.tag.startsWith(RUN_ID)) await deleteVia(`/tags/${tag.id}/delete`);
}

const cleanup = new Cleanup();
cleanup.add("RUN_ID のタグ", deleteRunTags);

const sessions: Partial<Record<"ro" | "rw" | "full", StdioSession>> = {};
const session = (key: keyof typeof sessions): StdioSession => {
  const s = sessions[key];
  if (!s) throw new Error(`MCP の登録 ${key} が起動していない`);
  return s;
};

beforeAll(async () => {
  const [ro, rw, full] = await Promise.all([startStdio("mautic", envFor("read_only")), startStdio("mautic", envFor("read_write")), startStdio("mautic", envFor("full"))]);
  Object.assign(sessions, { ro, rw, full });
});

afterAll(async () => {
  await Promise.allSettled(Object.values(sessions).map((s) => s.close()));
  await cleanup.runAll();
});

describe("mautic-mcp のツールの公開範囲（ACCESS_LEVEL）", () => {
  const names = async (key: "ro" | "rw" | "full") => (await session(key).client.listTools()).tools.map((t) => t.name);

  describe("正常系", () => {
    it("read_only ⊂ read_write ⊂ full で、件数は README の表のとおり（14 / 16 / 17）", async () => {
      const [ro, rw, full] = await Promise.all([names("ro"), names("rw"), names("full")]);
      expect([ro.length, rw.length, full.length]).toEqual([TOOL_COUNT.read_only, TOOL_COUNT.read_write, TOOL_COUNT.full]);
      for (const name of ro) expect(rw, name).toContain(name);
      for (const name of rw) expect(full, name).toContain(name);
    });

    it("作成・更新は read_write から、削除は full だけに出て、更新・削除には destructiveHint が付く", async () => {
      const [ro, rw] = await Promise.all([names("ro"), names("rw")]);
      for (const name of [...WRITE_TOOLS, ...DELETE_TOOLS]) expect(ro, name).not.toContain(name);
      for (const name of WRITE_TOOLS) expect(rw, name).toContain(name);
      for (const name of DELETE_TOOLS) expect(rw, name).not.toContain(name);

      const { tools } = await session("full").client.listTools();
      for (const name of ["mautic_update_record", "mautic_delete_record"]) expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint, name).toBe(true);
      for (const tool of tools) expect(tool.annotations?.readOnlyHint, tool.name).toBe(![...WRITE_TOOLS, ...DELETE_TOOLS].includes(tool.name));
    });
  });

  describe("異常系", () => {
    it("入力: read_only で mautic_create_record を呼ぶと、存在しないツールとして InvalidParams になる", async () => {
      const error = await call(session("ro"), "mautic_create_record", { resource: "tags", data: { tag: itName("never") } }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.InvalidParams);
      expect((error as ProtocolError).message).toContain("mautic_create_record");
    });

    it("入力: read_write で mautic_delete_record を呼んでも InvalidParams になる", async () => {
      await expect(call(session("rw"), "mautic_delete_record", { resource: "tags", id: 1 })).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
    });
  });
});

describe("参照系のツール", () => {
  describe("正常系", () => {
    it("空入力: mautic_list_contacts を引数なしで呼ぶと、total・offset 付きの一覧で返る", async () => {
      const result = ok(await call(session("ro"), "mautic_list_contacts"), "mautic_list_contacts");
      const data = structuredOf<{ total: number; offset: number; count: number; items: unknown[] }>(result);
      expect(typeof data.total).toBe("number");
      expect(data.offset).toBe(0);
      expect(data.count).toBe(data.items.length);
    });

    it("空入力: mautic_list_contacts の search が空文字でも、検索なしの一覧として返る", async () => {
      const result = ok(await call(session("ro"), "mautic_list_contacts", { search: "", limit: 1 }), "search=''");
      expect(structuredOf<{ count: number }>(result).count).toBeLessThanOrEqual(1);
    });

    it("mautic_list_records で設定スクリプトが用意したフォーム（相談）とセグメント（MQL）が見つかる", async () => {
      const forms = ok(await call(session("ro"), "mautic_list_records", { resource: "forms", limit: 100, response_format: "json" }), "forms");
      expect(structuredOf<{ items: Array<{ id: number }> }>(forms).items.map((i) => i.id)).toContain(Number(requireValue("MAUTIC_FORM_ID_CONSULT")));
      const segments = ok(await call(session("ro"), "mautic_list_records", { resource: "segments", limit: 100, response_format: "json" }), "segments");
      expect(structuredOf<{ resource: string; items: Array<{ id: number }> }>(segments).items.map((i) => i.id)).toContain(Number(requireValue("MAUTIC_SEGMENT_ID_MQL")));
    });

    it("response_format=json なら本文は structuredContent と同じ JSON、markdown なら見出し付きの文章になる", async () => {
      const id = Number(requireValue("MAUTIC_SEGMENT_ID_MQL"));
      const json = ok(await call(session("ro"), "mautic_get_record", { resource: "segments", id, response_format: "json" }), "json");
      expect(JSON.parse(textOf(json))).toEqual(structuredOf<{ record: unknown }>(json).record);
      const markdown = ok(await call(session("ro"), "mautic_get_record", { resource: "segments", id }), "markdown");
      expect(textOf(markdown)).toMatch(new RegExp(`^# segments ${id}`));
    });

    it("空入力: mautic_query_stats・mautic_get_dashboard_widget_data を引数なしで呼ぶと、選べるテーブル・ウィジェットの一覧を返す", async () => {
      for (const name of ["mautic_query_stats", "mautic_get_dashboard_widget_data"]) {
        const result = ok(await call(session("ro"), name), name);
        expect(textOf(result).length, name).toBeGreaterThan(0);
      }
    });

    it("参照系の応答にも、サーバの stderr にも client_secret とアクセストークンが出ない", async () => {
      const results = await Promise.all([
        call(session("ro"), "mautic_list_contacts", { limit: 5, response_format: "json" }),
        call(session("ro"), "mautic_list_records", { resource: "users", response_format: "json" }),
        call(session("ro"), "mautic_list_records", { resource: "webhooks", response_format: "json" }),
      ]);
      for (const result of results) {
        expect(containsAnySecret(textOf(result), secrets())).toBe(false);
        expect(textOf(result)).not.toMatch(/"access_token"/);
      }
      expect(containsAnySecret(session("ro").stderr(), secrets())).toBe(false);
    });
  });

  describe("異常系", () => {
    it("入力: 引数の型が違うと isError の検証エラーになる", async () => {
      const result = await call(session("ro"), "mautic_get_contact", { contact_id: "abc" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error.*contact_id/s);
    });

    it("空入力: 必須の resource が無いと isError の検証エラーになる", async () => {
      const result = await call(session("ro"), "mautic_list_records", {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error.*resource/s);
    });

    it("入力: limit が上限（100）を超えると検証エラーになる", async () => {
      const result = await call(session("ro"), "mautic_list_contacts", { limit: 101 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error.*limit/s);
    });

    it("入力: order_by に識別子でない文字列を渡すと、Mautic に送る前に検証エラーになる", async () => {
      const result = await call(session("ro"), "mautic_list_records", { resource: "segments", order_by: "name; DROP TABLE" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error.*order_by/s);
    });

    it("入力: 存在しないコンタクト ID は、上流の 404 が Not found のエラーとして返る", async () => {
      const result = await call(session("ro"), "mautic_get_contact", { contact_id: 999_999_999 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Not found/);
    });

    it("入力: 存在しないレコード ID（セグメント）も Not found になる", async () => {
      const result = await call(session("ro"), "mautic_get_record", { resource: "segments", id: 999_999_999 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Not found/);
    });

    it("サーバ: 存在しない列で並べ替えると Mautic が 500 を返し、order_by の誤りを示すエラーになる", async () => {
      const result = await call(session("ro"), "mautic_list_records", { resource: "segments", order_by: "itNoSuchColumn" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Mautic server error \(500\)\. An invalid order_by column/);
    });
  });
});

describe("書き込みの一巡（タグ・セグメント・コンタクト・ポイント）", () => {
  const tagName = itName("tag");
  const segmentAlias = itName("segment");
  const email = itEmail("contact");
  let tagId = 0;
  let segmentId = 0;
  let contactId = 0;

  describe("正常系", () => {
    it("mautic_create_record でタグとセグメント（非公開）を作れる", async () => {
      const tag = ok(await call(session("rw"), "mautic_create_record", { resource: "tags", data: { tag: tagName }, response_format: "json" }), "タグの作成");
      tagId = structuredOf<{ record: { id: number; tag: string } }>(tag).record.id;
      cleanup.add(`タグ ${tagId}`, () => deleteVia(`/tags/${tagId}/delete`));
      expect(structuredOf<{ action: string; record: { tag: string } }>(tag)).toMatchObject({ action: "created", record: { tag: tagName } });

      const segment = ok(
        await call(session("rw"), "mautic_create_record", {
          resource: "segments",
          data: { name: segmentAlias, alias: segmentAlias, isPublished: false, filters: [] },
          response_format: "json",
        }),
        "セグメントの作成",
      );
      segmentId = structuredOf<{ record: { id: number } }>(segment).record.id;
      cleanup.add(`セグメント ${segmentId}`, () => deleteVia(`/segments/${segmentId}/delete`));
      expect(structuredOf<{ record: { alias: string; isPublished: boolean } }>(segment).record).toMatchObject({ alias: segmentAlias, isPublished: false });
    });

    it("mautic_create_record でタグとポイント付きのコンタクトを作り、mautic_get_contact で読める", async () => {
      const created = ok(
        await call(session("rw"), "mautic_create_record", {
          resource: "contacts",
          data: { email, firstname: "it", lastname: RUN_ID, tags: [tagName], points: 5 },
          response_format: "json",
        }),
        "コンタクトの作成",
      );
      contactId = structuredOf<{ record: { id: number } }>(created).record.id;
      cleanup.add(`コンタクト ${contactId}`, () => deleteContact(contactId));

      const read = ok(await call(session("ro"), "mautic_get_contact", { contact_id: contactId, response_format: "json" }), "コンタクトの取得");
      expect(structuredOf<{ email: string; lastname: string; points: number; tags: string[] }>(read)).toMatchObject({ email, lastname: RUN_ID, points: 5, tags: [tagName] });
    });

    it("mautic_list_contacts の検索（email:）で作ったコンタクトだけが見つかる", async () => {
      const result = ok(await call(session("ro"), "mautic_list_contacts", { search: `email:${email}`, response_format: "json" }), "検索");
      const data = structuredOf<{ total: number; items: Array<{ id: number }> }>(result);
      expect(data.total).toBe(1);
      expect(data.items.map((i) => i.id)).toEqual([contactId]);
    });

    it("mautic_update_record（PATCH）でポイントを変え、'-' 付きのタグ指定でタグを外せる", async () => {
      const updated = ok(
        await call(session("rw"), "mautic_update_record", { resource: "contacts", id: contactId, data: { points: 42, tags: [`-${tagName}`] }, response_format: "json" }),
        "コンタクトの更新",
      );
      expect(structuredOf<{ action: string; record: { id: number } }>(updated)).toMatchObject({ action: "updated", record: { id: contactId } });

      const read = ok(await call(session("ro"), "mautic_get_contact", { contact_id: contactId, response_format: "json" }), "更新後の取得");
      expect(structuredOf<{ points: number; tags: string[] }>(read)).toMatchObject({ points: 42, tags: [] });
    });

    it("mautic_update_record でセグメントの名前を変えられる", async () => {
      const renamed = `${segmentAlias}-renamed`;
      const updated = ok(await call(session("rw"), "mautic_update_record", { resource: "segments", id: segmentId, data: { name: renamed }, response_format: "json" }), "セグメントの更新");
      expect(structuredOf<{ record: { name: string; alias: string } }>(updated).record).toMatchObject({ name: renamed, alias: segmentAlias });
    });

    it("mautic_delete_record（full）でコンタクト・セグメント・タグを消すと、以後は Not found になる", async () => {
      for (const [resource, id] of [
        ["contacts", contactId],
        ["segments", segmentId],
        ["tags", tagId],
      ] as const) {
        const deleted = ok(await call(session("full"), "mautic_delete_record", { resource, id, response_format: "json" }), `${resource} の削除`);
        expect(structuredOf<{ action: string }>(deleted).action, resource).toBe("deleted");
      }
      const contact = await call(session("ro"), "mautic_get_contact", { contact_id: contactId });
      expect(textOf(contact)).toMatch(/^Error: Not found/);
      const segment = await call(session("ro"), "mautic_get_record", { resource: "segments", id: segmentId });
      expect(textOf(segment)).toMatch(/^Error: Not found/);
    });
  });

  describe("異常系", () => {
    it("空入力: mautic_create_record の data が空オブジェクトなら検証エラーになる", async () => {
      const result = await call(session("rw"), "mautic_create_record", { resource: "tags", data: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/data must contain at least one field/);
    });

    it("入力: 書き込めないリソース名は検証エラーになる", async () => {
      const result = await call(session("rw"), "mautic_create_record", { resource: "it_no_such_resource", data: { name: "x" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error.*resource/s);
    });

    it("入力: 存在しない ID の更新は Not found になり、新しく作らない（PUT ではなく PATCH）", async () => {
      const name = itName("never-created");
      const result = await call(session("rw"), "mautic_update_record", { resource: "segments", id: 999_999_999, data: { name, alias: name } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Not found/);
      const search = ok(await call(session("ro"), "mautic_list_records", { resource: "segments", search: name, response_format: "json" }), "検索");
      expect(structuredOf<{ total: number }>(search).total).toBe(0);
    });

    it("入力: 存在しない ID の削除は Not found になる", async () => {
      const result = await call(session("full"), "mautic_delete_record", { resource: "tags", id: 999_999_999 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Not found/);
    });

    it("入力: メールアドレスの形式が違うコンタクトは、Mautic の入力エラー（フィールドの詳細付き）になる", async () => {
      const result = await call(session("rw"), "mautic_create_record", { resource: "contacts", data: { email: `${RUN_ID}-not-an-email` } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Mautic rejected the request .*email/s);
    });
  });
});

describe("sanitize と CHARACTER_LIMIT", () => {
  describe("正常系", () => {
    it("Webhook の secret は作成の応答でも mautic_get_record でも伏せ字になる", async () => {
      const secret = `it-secret-${randomBytes(12).toString("hex")}`;
      const created = ok(
        await call(session("rw"), "mautic_create_record", {
          resource: "webhooks",
          data: { name: itName("webhook"), webhookUrl: "http://127.0.0.1:9/it", secret, isPublished: false, triggers: ["mautic.lead_post_delete"] },
          response_format: "json",
        }),
        "Webhook の作成",
      );
      const id = structuredOf<{ record: { id: number } }>(created).record.id;
      cleanup.add(`Webhook ${id}`, () => deleteVia(`/hooks/${id}/delete`));

      const read = ok(await call(session("ro"), "mautic_get_record", { resource: "webhooks", id, response_format: "json" }), "Webhook の取得");
      for (const result of [created, read]) {
        expect(textOf(result).includes(secret)).toBe(false);
        expect(JSON.stringify(result.structuredContent).includes(secret)).toBe(false);
      }
      expect(structuredOf<{ record: { secret: string; isPublished: boolean } }>(read).record).toMatchObject({ secret: "[redacted]", isPublished: false });
    });

    it("一覧が CHARACTER_LIMIT を超えると件数を半分ずつ減らし、next_offset で残りを取れる", async () => {
      // 1 件あたり約 5,000 文字のタグを持つコンタクトを 6 件作る。6 件で上限（25,000 文字）を超える
      const tags = Array.from({ length: 40 }, (_, i) => `${RUN_ID}-t${String(i).padStart(2, "0")}-${"x".repeat(90)}`);
      const payload = Array.from({ length: 6 }, (_, i) => ({ email: itEmail(`bulk-${i}`), firstname: "it", lastname: RUN_ID, tags }));
      const res = await mauticApi<{ contacts: Array<{ id: number }> }>("/contacts/batch/new", { method: "POST", body: payload });
      if (res.status !== 201 && res.status !== 200) throw new Error(`コンタクトを作れない（HTTP ${res.status}）`);
      const ids = (res.json?.contacts ?? []).map((c) => Number(c.id));
      for (const id of ids) cleanup.add(`コンタクト ${id}`, () => deleteContact(id));
      expect(ids).toHaveLength(6);

      const search = `email:${RUN_ID}-bulk-%`;
      const first = ok(await call(session("ro"), "mautic_list_contacts", { search, limit: 100, order_by: "id", order_direction: "asc", response_format: "json" }), "1 回目");
      const firstText = textOf(first);
      const firstData = structuredOf<{ total: number; count: number; offset: number; has_more: boolean; next_offset?: number; truncation_message?: string; items: Array<{ id: number }> }>(first);
      expect(firstText.length).toBeLessThanOrEqual(25_000);
      expect(JSON.parse(firstText)).toEqual(firstData);
      expect(firstData.total).toBe(6);
      expect(firstData.count).toBeLessThan(6);
      expect(firstData.has_more).toBe(true);
      expect(firstData.next_offset).toBe(firstData.count);
      expect(firstData.truncation_message).toMatch(new RegExp(`offset=${firstData.count}`));

      // 残りは next_offset から取れる（Mautic は offset を受け付けるので、Chatwoot と違い切り詰めた分を取りこぼさない）
      const seen = firstData.items.map((i) => i.id);
      let offset = firstData.next_offset;
      while (offset !== undefined && seen.length < 6) {
        const next = ok(await call(session("ro"), "mautic_list_contacts", { search, limit: 100, offset, order_by: "id", order_direction: "asc", response_format: "json" }), `offset=${offset}`);
        const data = structuredOf<{ next_offset?: number; items: Array<{ id: number }> }>(next);
        expect(textOf(next).length).toBeLessThanOrEqual(25_000);
        seen.push(...data.items.map((i) => i.id));
        offset = data.next_offset;
      }
      expect([...seen].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));

      const markdown = ok(await call(session("ro"), "mautic_list_contacts", { search, limit: 100 }), "markdown");
      expect(textOf(markdown).length).toBeLessThanOrEqual(25_000);
      expect(textOf(markdown)).toMatch(/Response truncated to \d+ items/);
    });
  });
});

describe("HTTP トランスポート（Bearer: MCP_AUTH_TOKEN）", () => {
  let server: HttpServerProcess;

  beforeAll(async () => {
    server = await startHttp("mautic", envFor("read_only"));
  });

  afterAll(async () => {
    await server?.close();
  });

  describe("正常系", () => {
    it("正しい Bearer なら StreamableHTTPClientTransport で繋がり、ツールを呼べる", async () => {
      const client = await server.connect();
      expect((await client.listTools()).tools).toHaveLength(TOOL_COUNT.read_only);
      const result = (await client.callTool({ name: "mautic_list_contacts", arguments: { limit: 1, response_format: "json" } })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(typeof structuredOf<{ total: number }>(result).total).toBe("number");
    });
  });

  describe("異常系", () => {
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "it", version: "1" } } };
    const headers = { accept: "application/json, text/event-stream" };

    it("入力: Authorization ヘッダーが無いと 401 になる", async () => {
      const res = await http(server.url, { method: "POST", body: initialize, headers });
      expect(res.status).toBe(401);
    });

    it("入力: 違うトークンでは 401 になり、応答に正しいトークンが出ない", async () => {
      const res = await http(server.url, { method: "POST", body: initialize, headers: { ...headers, authorization: `Bearer ${"y".repeat(48)}` } });
      expect(res.status).toBe(401);
      expect(res.text.includes(server.token)).toBe(false);
    });

    it("空入力: Bearer の値が空だと 401 になる", async () => {
      const res = await http(server.url, { method: "POST", body: initialize, headers: { ...headers, authorization: "Bearer " } });
      expect(res.status).toBe(401);
    });

    it("入力: 違うトークンの MCP クライアントは接続に失敗する", async () => {
      await expect(server.connect(randomBytes(24).toString("hex"))).rejects.toThrow();
    });
  });
});

describe("起動時の設定の検証（config.ts）", () => {
  const marker = () => `it-${randomBytes(8).toString("hex")}`;

  describe("正常系", () => {
    // .env.example のまま空にした MCP_AUTH_TOKEN は未設定と同じに扱う（README）。dist が古い（この挙動が入る前のビルド）と失敗する
    it("空入力: stdio で MCP_AUTH_TOKEN が空文字でも起動できる", async () => {
      const s = await startStdio("mautic", { ...envFor("read_only"), MCP_AUTH_TOKEN: "", MCP_ALLOWED_HOSTS: "" });
      try {
        expect((await s.client.listTools()).tools).toHaveLength(TOOL_COUNT.read_only);
      } finally {
        await s.close();
      }
    });
  });

  describe("異常系", () => {
    it("入力: MAUTIC_CLIENT_SECRET が無いと終了コード 1 で、stderr には変数名だけが出る（ほかの値も出さない）", async () => {
      const { MAUTIC_CLIENT_SECRET: _omit, ...env } = envFor("read_only");
      const result = await runUntilExit("mautic", { ...env, TRANSPORT: "stdio" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("MAUTIC_CLIENT_SECRET");
      expect(result.stderr.includes(env.MAUTIC_CLIENT_ID!)).toBe(false);
      expect(result.stdout).toBe("");
    });

    it("入力: MAUTIC_BASE_URL が URL でないと終了コード 1 で、値は stderr に出ない", async () => {
      const value = marker();
      const result = await runUntilExit("mautic", { ...envFor("read_only"), TRANSPORT: "stdio", MAUTIC_BASE_URL: value });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("MAUTIC_BASE_URL");
      expect(result.stderr.includes(value)).toBe(false);
      expect(containsAnySecret(result.stderr, secrets())).toBe(false);
    });

    it("入力: TRANSPORT を指定しないと既定の HTTP になり、MCP_AUTH_TOKEN が無ければ終了コード 1 になる", async () => {
      const result = await runUntilExit("mautic", envFor("read_only"));
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/MCP_AUTH_TOKEN: TRANSPORT=http の場合は必須です/);
    });

    it("入力: MCP_AUTH_TOKEN が 32 文字未満だと終了コード 1 で、値は stderr に出ない", async () => {
      const value = marker();
      const result = await runUntilExit("mautic", { ...envFor("read_only"), TRANSPORT: "http", MCP_AUTH_TOKEN: value });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/MCP_AUTH_TOKEN: 32 文字以上にしてください/);
      expect(result.stderr.includes(value)).toBe(false);
    });

    it("空入力: MAUTIC_CLIENT_ID が空文字でも終了コード 1 になる", async () => {
      const result = await runUntilExit("mautic", { ...envFor("read_only"), TRANSPORT: "stdio", MAUTIC_CLIENT_ID: "" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("MAUTIC_CLIENT_ID");
      expect(containsAnySecret(result.stderr, secrets())).toBe(false);
    });
  });
});

describe("上流（Mautic）の認証と到達性", () => {
  describe("異常系", () => {
    it("入力: 不正な client_secret では、トークンの取得に失敗したことが再試行しても直らないエラーとして返り、値は本文に出ない", async () => {
      const invalid = `it-invalid-${randomBytes(12).toString("hex")}`;
      const s = await startStdio("mautic", { ...envFor("read_only"), MAUTIC_CLIENT_SECRET: invalid });
      try {
        const result = await call(s, "mautic_list_contacts", { limit: 1 });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/^Error: Failed to obtain Mautic access token.*cannot be fixed by retrying/s);
        expect(textOf(result).includes(invalid)).toBe(false);
        expect(s.stderr().includes(invalid)).toBe(false);
      } finally {
        await s.close();
      }
    });

    it("サーバ: MAUTIC_BASE_URL が閉じたポート（127.0.0.1:9）だと、通信失敗のエラーとして返る", async () => {
      const s = await startStdio("mautic", { ...envFor("read_only"), MAUTIC_BASE_URL: "http://127.0.0.1:9" });
      try {
        for (const [name, args] of [
          ["mautic_list_contacts", {}],
          ["mautic_get_record", { resource: "segments", id: 1 }],
        ] as const) {
          const result = await call(s, name, args);
          expect(result.isError, name).toBe(true);
          expect(textOf(result), name).toMatch(/^Error: Could not reach Mautic \(network error\)/);
          expect(containsAnySecret(textOf(result), secrets()), name).toBe(false);
        }
      } finally {
        await s.close();
      }
    });
  });
});
