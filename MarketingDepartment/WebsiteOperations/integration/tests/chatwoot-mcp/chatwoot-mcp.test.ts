import { randomBytes } from "node:crypto";

import { ProtocolError, ProtocolErrorCode, type CallToolResult } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chatwootApi, deleteChatwootContact, deleteChatwootConversation } from "../helpers/chatwoot.ts";
import { Cleanup } from "../helpers/cleanup.ts";
import { mcpEnv, requireValue } from "../helpers/env.ts";
import { http } from "../helpers/http.ts";
import { itEmail, itName, RUN_ID } from "../helpers/run-id.ts";
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
} from "./mcp-server.ts";

/**
 * I-03 エージェント → chatwoot-mcp → 開発の Chatwoot（127.0.0.1:3100）。
 *
 * ビルド済みの backend/chatwoot-mcp/dist/index.js を MCP SDK の Client（stdio）で起動し、本物の Chatwoot に対してツールを呼ぶ。
 * エージェントと同じ登録（~/.config/comegin/mcp/chatwoot-dev.env。トークンはエージェント専用ユーザー〈role=agent〉。ADR-17）を基本にし、
 * 管理者にしかできない操作（ラベルの作成・コンタクトの削除・受信箱の詳細）だけ CHATWOOT_ADMIN_TOKEN に差し替えた登録で呼ぶ。
 *
 * - テストで作るデータは `it-` で始め、作った直後に Cleanup に登録する（会話の削除は管理者の REST API。helpers/chatwoot.ts）
 * - 会話を作るコンタクトにはメールを付けない。担当 C が有効にしている n8n の I-12（conversation_created）が Mautic にコンタクトを作らないようにするため
 * - 秘密値（トークン）は失敗の文に出さない。含まれるかどうかだけを containsAnySecret で見る
 */

const TOOL_COUNT: Record<AccessLevel, number> = { read_only: 17, read_write: 28, full: 32 };
const WRITE_TOOLS = [
  "chatwoot_send_message",
  "chatwoot_add_private_note",
  "chatwoot_update_conversation",
  "chatwoot_create_conversation",
  "chatwoot_create_contact",
  "chatwoot_update_contact",
  "chatwoot_create_record",
  "chatwoot_update_record",
  "chatwoot_update_account",
  "chatwoot_set_members",
  "chatwoot_set_inbox_agent_bot",
];
const DELETE_TOOLS = ["chatwoot_delete_record", "chatwoot_delete_contact", "chatwoot_delete_message", "chatwoot_merge_contacts"];

/** エージェントの登録（mcp の env）に ACCESS_LEVEL を足したもの */
const agentEnv = (level: AccessLevel): Record<string, string> => ({ ...mcpEnv("chatwoot"), CHATWOOT_ACCESS_LEVEL: level });
/** 管理者のトークンに差し替えた登録（ラベルの作成・削除系の確認用） */
const adminEnv = (level: AccessLevel): Record<string, string> => ({ ...agentEnv(level), CHATWOOT_API_ACCESS_TOKEN: requireValue("CHATWOOT_ADMIN_TOKEN") });

/** 応答に出てはいけない値（Chatwoot の 2 つのトークン） */
const secrets = (): string[] => [requireValue("CHATWOOT_ADMIN_TOKEN"), requireValue("CHATWOOT_AGENT_TOKEN")];

const call = (session: StdioSession, name: string, args: Record<string, unknown> = {}) =>
  session.client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

/** 成功を確かめて返す（失敗なら本文の 1 行目を添える。本文に秘密値が含まれないことは別のテストで確かめる） */
function ok(result: CallToolResult, context: string): CallToolResult {
  expect(result.isError, `${context}: ${textOf(result).split("\n")[0]}`).not.toBe(true);
  return result;
}

const sessions: Partial<Record<"ro" | "rw" | "full" | "adminFull", StdioSession>> = {};
const session = (key: keyof typeof sessions): StdioSession => {
  const s = sessions[key];
  if (!s) throw new Error(`MCP の登録 ${key} が起動していない`);
  return s;
};

beforeAll(async () => {
  const [ro, rw, full, adminFull] = await Promise.all([
    startStdio("chatwoot", agentEnv("read_only")),
    startStdio("chatwoot", agentEnv("read_write")),
    startStdio("chatwoot", agentEnv("full")),
    startStdio("chatwoot", adminEnv("full")),
  ]);
  Object.assign(sessions, { ro, rw, full, adminFull });
});

afterAll(async () => {
  await Promise.allSettled(Object.values(sessions).map((s) => s.close()));
});

describe("chatwoot-mcp のツールの公開範囲（ACCESS_LEVEL）", () => {
  const names = async (key: "ro" | "rw" | "full") => (await session(key).client.listTools()).tools.map((t) => t.name);

  describe("正常系", () => {
    it("read_only ⊂ read_write ⊂ full で、件数は README の表のとおり（17 / 28 / 32）", async () => {
      const [ro, rw, full] = await Promise.all([names("ro"), names("rw"), names("full")]);
      expect([ro.length, rw.length, full.length]).toEqual([TOOL_COUNT.read_only, TOOL_COUNT.read_write, TOOL_COUNT.full]);
      for (const name of ro) expect(rw, name).toContain(name);
      for (const name of rw) expect(full, name).toContain(name);
    });

    it("書き込みツールは read_write から、削除・統合ツールは full だけに出る", async () => {
      const [ro, rw, full] = await Promise.all([names("ro"), names("rw"), names("full")]);
      for (const name of [...WRITE_TOOLS, ...DELETE_TOOLS]) expect(ro, name).not.toContain(name);
      for (const name of WRITE_TOOLS) expect(rw, name).toContain(name);
      for (const name of DELETE_TOOLS) {
        expect(rw, name).not.toContain(name);
        expect(full, name).toContain(name);
      }
    });

    it("どのツールにも説明・入力スキーマ・注釈があり、書き込みツールは readOnlyHint が false", async () => {
      const { tools } = await session("full").client.listTools();
      for (const tool of tools) {
        expect(tool.description?.length ?? 0, tool.name).toBeGreaterThanOrEqual(40);
        expect(tool.inputSchema.type, tool.name).toBe("object");
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(!WRITE_TOOLS.includes(tool.name) && !DELETE_TOOLS.includes(tool.name));
      }
      for (const name of DELETE_TOOLS) expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint, name).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: read_only で書き込みツールを呼ぶと、存在しないツールとして InvalidParams になる", async () => {
      const error = await call(session("ro"), "chatwoot_add_private_note", { conversation_id: 1, content: "it" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.InvalidParams);
      expect((error as ProtocolError).message).toContain("chatwoot_add_private_note");
    });

    it("入力: read_write で削除ツールを呼んでも、存在しないツールとして InvalidParams になる", async () => {
      const error = await call(session("rw"), "chatwoot_delete_contact", { contact_id: 1 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.InvalidParams);
    });

    it("入力: 存在しない名前のツールも InvalidParams になる", async () => {
      await expect(call(session("full"), "chatwoot_no_such_tool")).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
    });
  });
});

describe("参照系のツール（エージェントのトークン）", () => {
  describe("正常系", () => {
    it("空入力: chatwoot_get_account を引数なしで呼ぶと、設定のアカウント・接続ユーザー（agent）・access_level を返す", async () => {
      const result = ok(await call(session("ro"), "chatwoot_get_account"), "chatwoot_get_account");
      const data = structuredOf<{ access_level: string; account: { id: number }; user: { id: number; role: string } }>(result);
      expect(data.access_level).toBe("read_only");
      expect(data.account.id).toBe(Number(requireValue("CHATWOOT_ACCOUNT_ID")));
      expect(data.user.id).toBe(Number(requireValue("CHATWOOT_AGENT_USER_ID")));
      expect(data.user.role).toBe("agent");
      // 既定の markdown は見出し付きの文章
      expect(textOf(result)).toMatch(/^# Chatwoot account /);
    });

    it("response_format=json なら本文は structuredContent と同じ JSON になる", async () => {
      const result = ok(await call(session("ro"), "chatwoot_get_account", { response_format: "json" }), "json");
      expect(JSON.parse(textOf(result))).toEqual(structuredOf(result));
    });

    it("chatwoot_list_records（inboxes）に設定スクリプトが用意した受信箱が含まれる", async () => {
      const result = ok(await call(session("ro"), "chatwoot_list_records", { resource: "inboxes", response_format: "json" }), "inboxes");
      const data = structuredOf<{ resource: string; items: Array<{ id: number }> }>(result);
      expect(data.resource).toBe("inboxes");
      expect(data.items.map((i) => i.id)).toContain(Number(requireValue("CHATWOOT_INBOX_ID")));
    });

    it("空入力: chatwoot_list_conversations を引数なしで呼ぶと、ページ情報と件数（counts）を返す", async () => {
      const result = ok(await call(session("ro"), "chatwoot_list_conversations"), "chatwoot_list_conversations");
      const data = structuredOf<{ page: number; has_more: boolean; counts: Record<string, number>; items: unknown[] }>(result);
      expect(data.page).toBe(1);
      expect(typeof data.counts.all_count).toBe("number");
      expect(Array.isArray(data.items)).toBe(true);
    });

    it("空入力: chatwoot_list_contacts を引数なしで呼んでも一覧の形で返る", async () => {
      const result = ok(await call(session("ro"), "chatwoot_list_contacts"), "chatwoot_list_contacts");
      expect(structuredOf<{ page: number; items: unknown[] }>(result).page).toBe(1);
    });

    it("参照系の応答にも、サーバの stderr にも Chatwoot のトークンが出ない", async () => {
      const results = await Promise.all([
        call(session("ro"), "chatwoot_get_account", { response_format: "json" }),
        call(session("ro"), "chatwoot_list_records", { resource: "agents", response_format: "json" }),
        call(session("ro"), "chatwoot_list_conversations", { status: "all", response_format: "json" }),
      ]);
      for (const result of results) {
        expect(containsAnySecret(textOf(result), secrets())).toBe(false);
        expect(containsAnySecret(JSON.stringify(result.structuredContent ?? {}), secrets())).toBe(false);
      }
      expect(containsAnySecret(session("ro").stderr(), secrets())).toBe(false);
    });
  });

  describe("異常系", () => {
    it("入力: 引数の型が違うと isError の検証エラーになる（Chatwoot へは送らない）", async () => {
      const result = await call(session("ro"), "chatwoot_get_conversation", { conversation_id: "abc" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error.*conversation_id/s);
    });

    it("入力: 必須の引数が無いと isError の検証エラーになる", async () => {
      const result = await call(session("ro"), "chatwoot_get_contact", {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error.*contact_id/s);
    });

    it("入力: スキーマに無いキーは拒否される（strictObject）", async () => {
      const result = await call(session("ro"), "chatwoot_get_account", { it_unknown: 1 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Unrecognized key/);
    });

    it("空入力: 検索語 q に空文字を渡すと検証エラーになる", async () => {
      const result = await call(session("ro"), "chatwoot_list_contacts", { q: "" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error.*q/s);
    });

    it("入力: 存在しない会話の番号（display_id）は、上流の 404 が次の手順付きのエラーとして返る", async () => {
      const result = await call(session("ro"), "chatwoot_get_conversation", { conversation_id: 999_999 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Not found .*chatwoot_list_conversations/s);
    });

    it("入力: 存在しないコンタクト ID は Not found になる", async () => {
      const result = await call(session("ro"), "chatwoot_get_contact", { contact_id: 999_999_999 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Not found .*chatwoot_list_contacts/s);
    });

    it("入力: エージェントのトークンで管理者専用のレポートを呼ぶと、権限不足（Chatwoot の 401）がエラーとして返る", async () => {
      const result = await call(session("ro"), "chatwoot_get_report_summary", { since: "2026-01-01" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Permission denied/);
    });
  });
});

// 書き込みの一巡と削除で、作ったものを共有する（削除の確認は一巡の後に行う）
const writeCleanup = new Cleanup();
const labelTitle = itName("label");
const contactName = itName("contact");
let labelId = 0;
let contactId = 0;
let conversationId = 0;

afterAll(async () => {
  await writeCleanup.runAll();
});

describe("書き込みの一巡（コンタクト → 会話 → 社内メモ → ラベル）", () => {
  beforeAll(async () => {
    // ラベルの作成は管理者だけ。管理者の登録（full）の chatwoot_create_record で作る
    const created = ok(
      await call(session("adminFull"), "chatwoot_create_record", { resource: "labels", data: { title: labelTitle, description: RUN_ID }, response_format: "json" }),
      "ラベルの作成",
    );
    labelId = structuredOf<{ record: { id: number } }>(created).record.id;
    writeCleanup.add(`ラベル ${labelTitle}`, async () => {
      const res = await chatwootApi(`/labels/${labelId}`, { method: "DELETE" });
      if (res.status !== 200 && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    });
  });

  describe("正常系", () => {
    it("chatwoot_create_contact（read_write・エージェント）でコンタクトを作り、chatwoot_get_contact で読める", async () => {
      const created = ok(
        await call(session("rw"), "chatwoot_create_contact", { name: contactName, custom_attributes: { it_run: RUN_ID }, response_format: "json" }),
        "コンタクトの作成",
      );
      contactId = structuredOf<{ contact: { id: number } }>(created).contact.id;
      writeCleanup.add(`コンタクト ${contactId}`, () => deleteChatwootContact(contactId));

      const read = ok(await call(session("ro"), "chatwoot_get_contact", { contact_id: contactId, response_format: "json" }), "コンタクトの取得");
      const contact = structuredOf<{ contact: { name: string; custom_attributes: Record<string, unknown> } }>(read).contact;
      expect(contact.name).toBe(contactName);
      expect(contact.custom_attributes.it_run).toBe(RUN_ID);
    });

    it("chatwoot_create_conversation で開発の受信箱（CHATWOOT_INBOX_ID）に会話を作ると、表示番号で読み直せる", async () => {
      const created = ok(
        await call(session("rw"), "chatwoot_create_conversation", {
          inbox_id: Number(requireValue("CHATWOOT_INBOX_ID")),
          contact_id: contactId,
          status: "open",
          response_format: "json",
        }),
        "会話の作成",
      );
      conversationId = structuredOf<{ conversation: { id: number } }>(created).conversation.id;
      writeCleanup.add(`会話 #${conversationId}`, () => deleteChatwootConversation(conversationId));

      const read = ok(await call(session("ro"), "chatwoot_get_conversation", { conversation_id: conversationId, response_format: "json" }), "会話の取得");
      const conversation = structuredOf<{ conversation: { id: number; contact: { id: number } } }>(read).conversation;
      expect(conversation.id).toBe(conversationId);
      expect(conversation.contact.id).toBe(contactId);
    });

    it("chatwoot_add_private_note の社内メモは private として記録され、履歴（chatwoot_list_messages）にも private で並ぶ", async () => {
      const note = ok(await call(session("rw"), "chatwoot_add_private_note", { conversation_id: conversationId, content: `${RUN_ID} 社内メモ` }), "社内メモ");
      expect(structuredOf<{ message: { private: boolean } }>(note).message.private).toBe(true);

      const messages = ok(await call(session("ro"), "chatwoot_list_messages", { conversation_id: conversationId, response_format: "json" }), "履歴");
      const items = structuredOf<{ messages: Array<{ content?: string; private?: boolean }> }>(messages).messages;
      const recorded = items.find((m) => m.content === `${RUN_ID} 社内メモ`);
      expect(recorded?.private).toBe(true);
    });

    it("chatwoot_update_conversation で状態・優先度・ラベルをまとめて変えられる", async () => {
      const updated = ok(
        await call(session("rw"), "chatwoot_update_conversation", {
          conversation_id: conversationId,
          status: "pending",
          priority: "high",
          labels: { add: [labelTitle] },
          response_format: "json",
        }),
        "会話の更新",
      );
      const data = structuredOf<{ applied: string[]; conversation: { status: string; priority: string; labels?: string[] } }>(updated);
      expect(data.applied).toEqual(["status", "priority", "labels"]);
      expect(data.conversation.status).toBe("pending");
      expect(data.conversation.priority).toBe("high");
      expect(data.conversation.labels).toContain(labelTitle);
    });

    it("ラベルで絞った会話の一覧に、作った会話が出る", async () => {
      const result = ok(await call(session("ro"), "chatwoot_list_conversations", { status: "all", labels: [labelTitle], response_format: "json" }), "ラベルで絞る");
      expect(structuredOf<{ items: Array<{ id: number }> }>(result).items.map((i) => i.id)).toEqual([conversationId]);
    });

    it("chatwoot_update_contact でカスタム属性を更新・削除できる", async () => {
      const updated = ok(
        await call(session("rw"), "chatwoot_update_contact", {
          contact_id: contactId,
          custom_attributes: { it_stage: "updated" },
          remove_custom_attributes: ["it_run"],
          response_format: "json",
        }),
        "コンタクトの更新",
      );
      const data = structuredOf<{ applied: string[]; contact: { custom_attributes: Record<string, unknown> } }>(updated);
      expect(data.applied).toEqual(["fields", "remove_custom_attributes"]);
      expect(data.contact.custom_attributes).toEqual({ it_stage: "updated" });
    });

  });

  describe("異常系", () => {
    it("入力: chatwoot_add_private_note に private を渡すと拒否され、メッセージは作られない", async () => {
      const content = `${RUN_ID} 拒否されるはず`;
      const result = await call(session("rw"), "chatwoot_add_private_note", { conversation_id: conversationId, content, private: false });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Unrecognized key.*private/s);

      const messages = ok(await call(session("ro"), "chatwoot_list_messages", { conversation_id: conversationId, response_format: "json" }), "履歴");
      expect(structuredOf<{ messages: Array<{ content?: string }> }>(messages).messages.some((m) => m.content === content)).toBe(false);
    });

    it("空入力: chatwoot_add_private_note の content が空文字なら検証エラーになる", async () => {
      const result = await call(session("rw"), "chatwoot_add_private_note", { conversation_id: conversationId, content: "" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error.*content/s);
    });

    it("入力: 存在しない会話への社内メモは Not found になる", async () => {
      const result = await call(session("rw"), "chatwoot_add_private_note", { conversation_id: 999_999, content: `${RUN_ID} 届かない` });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Not found/);
    });

    it("空入力: chatwoot_update_conversation に変更内容が無いと、Chatwoot を呼ばずに拒否する", async () => {
      const result = await call(session("rw"), "chatwoot_update_conversation", { conversation_id: conversationId });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: nothing to update/);
    });

    it("空入力: chatwoot_create_contact を引数なしで呼ぶと、作らずに拒否する", async () => {
      const result = await call(session("rw"), "chatwoot_create_contact", {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("Error: give at least one of name, email, phone_number or identifier.");
    });
  });
});

describe("削除（full）", () => {
  describe("正常系", () => {
    it("chatwoot_delete_contact（full・管理者）で消すと、以後は Not found になる", async () => {
      const deleted = ok(await call(session("adminFull"), "chatwoot_delete_contact", { contact_id: contactId }), "コンタクトの削除");
      expect(JSON.parse(textOf(deleted))).toEqual({ deleted: "contact", id: contactId });
      const read = await call(session("ro"), "chatwoot_get_contact", { contact_id: contactId });
      expect(read.isError).toBe(true);
      expect(textOf(read)).toMatch(/^Error: Not found/);
    });

    it("chatwoot_delete_record（full・管理者）でラベルを消すと、ラベルの一覧から消える", async () => {
      ok(await call(session("adminFull"), "chatwoot_delete_record", { resource: "labels", id: labelId }), "ラベルの削除");
      const labels = ok(await call(session("ro"), "chatwoot_list_records", { resource: "labels", response_format: "json" }), "ラベルの一覧");
      expect(structuredOf<{ items: Array<{ id: number }> }>(labels).items.map((i) => i.id)).not.toContain(labelId);
    });
  });

  describe("異常系", () => {
    it("入力: エージェントのトークンの full 登録で chatwoot_delete_contact を呼ぶと、権限不足になりコンタクトは残る", async () => {
      // 一巡のコンタクトは正常系で消すため、このテスト用に管理者の REST API で 1 件作る
      const res = await chatwootApi<{ payload: { contact: { id: number } } }>("/contacts", { method: "POST", body: { name: itName("keep") } });
      if (res.status !== 200 || !res.json) throw new Error(`コンタクトを作れない（HTTP ${res.status}）`);
      const id = res.json.payload.contact.id;
      writeCleanup.add(`コンタクト ${id}`, () => deleteChatwootContact(id));

      const result = await call(session("full"), "chatwoot_delete_contact", { contact_id: id });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Permission denied/);
      ok(await call(session("ro"), "chatwoot_get_contact", { contact_id: id }), "削除されていないこと");
    });

    it("入力: 存在しない ID の削除は Not found になる", async () => {
      const result = await call(session("adminFull"), "chatwoot_delete_contact", { contact_id: 999_999_999 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Not found/);
    });
  });
});

describe("sanitize と CHARACTER_LIMIT", () => {
  const cleanup = new Cleanup();

  afterAll(async () => {
    await cleanup.runAll();
  });

  describe("正常系", () => {
    it("受信箱の詳細（管理者）では hmac_token が伏せ字になり、公開前提の website_token はそのまま返る", async () => {
      const result = ok(
        await call(session("adminFull"), "chatwoot_get_record", { resource: "inboxes", id: Number(requireValue("CHATWOOT_INBOX_ID")), response_format: "json" }),
        "受信箱の詳細",
      );
      const record = structuredOf<{ record: Record<string, unknown> }>(result).record;
      expect(record.hmac_token).toBe("[redacted]");
      expect(record.website_token).toBe(requireValue("CHATWOOT_WEBSITE_TOKEN"));
      expect(containsAnySecret(textOf(result), secrets())).toBe(false);
    });

    it("コンタクトのカスタム属性のキーが秘匿情報らしい（it_api_token）とき、値は伏せ字になる", async () => {
      const value = `it-secret-${randomBytes(12).toString("hex")}`;
      const created = ok(
        await call(session("rw"), "chatwoot_create_contact", { name: itName("secret"), custom_attributes: { it_api_token: value, it_plan: "trial" }, response_format: "json" }),
        "コンタクトの作成",
      );
      const id = structuredOf<{ contact: { id: number } }>(created).contact.id;
      cleanup.add(`コンタクト ${id}`, () => deleteChatwootContact(id));

      const read = await call(session("ro"), "chatwoot_get_contact", { contact_id: id, response_format: "json" });
      for (const result of [created, read]) {
        expect(textOf(result).includes(value)).toBe(false);
        expect(JSON.stringify(result.structuredContent).includes(value)).toBe(false);
      }
      // 秘匿情報らしくないキーの値は残る
      expect(structuredOf<{ contact: { custom_attributes: Record<string, unknown> } }>(read).contact.custom_attributes).toEqual({ it_api_token: "[redacted]", it_plan: "trial" });
    });

    it("1 ページの一覧が CHARACTER_LIMIT を超えると件数を半分ずつ減らし、本文は上限内の正しい JSON のまま truncation_message を付ける", async () => {
      // 1 件あたり約 2,800 文字のカスタム属性を持つコンタクトを 15 件（1 ページ分）作る。15 件で上限（25,000 文字）を超える
      const filler = (c: string) => c.repeat(900);
      const ids = await Promise.all(
        Array.from({ length: 15 }, async (_, i) => {
          const res = await chatwootApi<{ payload: { contact: { id: number } } }>("/contacts", {
            method: "POST",
            body: { name: itName(`bulk-${i}`), email: itEmail(`bulk-${i}`), custom_attributes: { it_a: filler("a"), it_b: filler("b"), it_c: filler("c") } },
          });
          if (res.status !== 200 || !res.json) throw new Error(`コンタクトを作れない（HTTP ${res.status}）`);
          const id = res.json.payload.contact.id;
          cleanup.add(`コンタクト ${id}`, () => deleteChatwootContact(id));
          return id;
        }),
      );

      for (const format of ["json", "markdown"] as const) {
        const result = ok(await call(session("ro"), "chatwoot_list_contacts", { q: `${RUN_ID}-bulk`, response_format: format }), `一覧（${format}）`);
        const text = textOf(result);
        const data = structuredOf<{ count: number; items: Array<{ id: number }>; truncation_message?: string }>(result);
        expect(text.length, format).toBeLessThanOrEqual(25_000);
        expect(data.count, format).toBe(data.items.length);
        expect(data.count, format).toBeLessThan(15);
        expect(data.count, format).toBeGreaterThan(0);
        expect(data.truncation_message, format).toMatch(/Response truncated to the first \d+ items/);
        for (const item of data.items) expect(ids, format).toContain(item.id);
        if (format === "json") expect(JSON.parse(text)).toEqual(data);
      }
    });
  });

  describe("異常系", () => {
    it("入力: 存在しないリソース ID の受信箱は Not found になり、一覧で探すよう案内する", async () => {
      const result = await call(session("adminFull"), "chatwoot_get_record", { resource: "inboxes", id: 999_999 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error: Not found .*chatwoot_list_records resource="inboxes"/s);
    });
  });
});

describe("HTTP トランスポート（Bearer: MCP_AUTH_TOKEN）", () => {
  let server: HttpServerProcess;

  beforeAll(async () => {
    server = await startHttp("chatwoot", agentEnv("read_only"));
  });

  afterAll(async () => {
    await server?.close();
  });

  describe("正常系", () => {
    it("正しい Bearer なら StreamableHTTPClientTransport で繋がり、ツールを呼べる", async () => {
      const client = await server.connect();
      expect((await client.listTools()).tools).toHaveLength(TOOL_COUNT.read_only);
      const result = (await client.callTool({ name: "chatwoot_get_account", arguments: { response_format: "json" } })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(structuredOf<{ access_level: string }>(result).access_level).toBe("read_only");
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
      const res = await http(server.url, { method: "POST", body: initialize, headers: { ...headers, authorization: `Bearer ${"x".repeat(48)}` } });
      expect(res.status).toBe(401);
      expect(res.text.includes(server.token)).toBe(false);
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
      const s = await startStdio("chatwoot", { ...agentEnv("read_only"), MCP_AUTH_TOKEN: "", MCP_ALLOWED_HOSTS: "" });
      try {
        expect((await s.client.listTools()).tools).toHaveLength(TOOL_COUNT.read_only);
      } finally {
        await s.close();
      }
    });
  });

  describe("異常系", () => {
    it("入力: CHATWOOT_API_ACCESS_TOKEN が無いと終了コード 1 で、stderr には変数名だけが出る", async () => {
      const { CHATWOOT_API_ACCESS_TOKEN: _omit, ...env } = agentEnv("read_only");
      const result = await runUntilExit("chatwoot", { ...env, TRANSPORT: "stdio" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("CHATWOOT_API_ACCESS_TOKEN");
      expect(containsAnySecret(result.stderr, secrets())).toBe(false);
      expect(result.stdout).toBe("");
    });

    it("入力: CHATWOOT_BASE_URL が URL でないと終了コード 1 で、値は stderr に出ない", async () => {
      const value = marker();
      const result = await runUntilExit("chatwoot", { ...agentEnv("read_only"), TRANSPORT: "stdio", CHATWOOT_BASE_URL: value });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("CHATWOOT_BASE_URL");
      expect(result.stderr.includes(value)).toBe(false);
      expect(containsAnySecret(result.stderr, secrets())).toBe(false);
    });

    it("入力: TRANSPORT=http で MCP_AUTH_TOKEN が無いと終了コード 1 になる", async () => {
      const result = await runUntilExit("chatwoot", { ...agentEnv("read_only"), TRANSPORT: "http" });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/MCP_AUTH_TOKEN: TRANSPORT=http の場合は必須です/);
    });

    it("入力: MCP_AUTH_TOKEN が 32 文字未満だと終了コード 1 で、値は stderr に出ない", async () => {
      const value = marker(); // 19 文字
      const result = await runUntilExit("chatwoot", { ...agentEnv("read_only"), TRANSPORT: "http", MCP_AUTH_TOKEN: value });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/MCP_AUTH_TOKEN: 32 文字以上にしてください/);
      expect(result.stderr.includes(value)).toBe(false);
    });

    it("入力: CHATWOOT_ACCESS_LEVEL が許された値でないと終了コード 1 になる", async () => {
      const result = await runUntilExit("chatwoot", { ...agentEnv("read_only"), TRANSPORT: "stdio", CHATWOOT_ACCESS_LEVEL: "admin" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("CHATWOOT_ACCESS_LEVEL");
    });

    it("空入力: CHATWOOT_API_ACCESS_TOKEN が空文字でも終了コード 1 になる", async () => {
      const result = await runUntilExit("chatwoot", { ...agentEnv("read_only"), TRANSPORT: "stdio", CHATWOOT_API_ACCESS_TOKEN: "" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("CHATWOOT_API_ACCESS_TOKEN");
    });
  });
});

describe("上流（Chatwoot）の認証と到達性", () => {
  describe("異常系", () => {
    it("入力: 不正な api_access_token では、Chatwoot の 401 が再試行しても直らないエラーとして返り、トークンは本文に出ない", async () => {
      const invalid = `it-invalid-${randomBytes(12).toString("hex")}`;
      const s = await startStdio("chatwoot", { ...agentEnv("read_only"), CHATWOOT_API_ACCESS_TOKEN: invalid });
      try {
        const result = await call(s, "chatwoot_get_account");
        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/^Error: Chatwoot rejected the access token/);
        expect(textOf(result).includes(invalid)).toBe(false);
        expect(s.stderr().includes(invalid)).toBe(false);
      } finally {
        await s.close();
      }
    });

    it("サーバ: CHATWOOT_BASE_URL が閉じたポート（127.0.0.1:9）だと、通信失敗のエラーとして返る", async () => {
      const s = await startStdio("chatwoot", { ...agentEnv("read_only"), CHATWOOT_BASE_URL: "http://127.0.0.1:9" });
      try {
        for (const [name, args] of [
          ["chatwoot_get_account", {}],
          ["chatwoot_list_conversations", { status: "all" }],
        ] as const) {
          const result = await call(s, name, args);
          expect(result.isError, name).toBe(true);
          expect(textOf(result), name).toMatch(/^Error: Could not reach Chatwoot \(network error\)/);
          expect(containsAnySecret(textOf(result), secrets()), name).toBe(false);
        }
      } finally {
        await s.close();
      }
    });
  });
});
