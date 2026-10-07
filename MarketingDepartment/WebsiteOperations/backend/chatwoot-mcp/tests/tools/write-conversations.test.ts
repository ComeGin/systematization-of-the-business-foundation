import { describe, expect, it } from "vitest";

import { CREATE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS } from "../../src/tools/annotations.js";
import { CONVERSATION_NOT_FOUND } from "../../src/tools/conversations.js";
import { LabelChangeSchema, registerConversationWriteTools } from "../../src/tools/write-conversations.js";
import { callKeys, installFetch, installFetchFailure, networkError, routes, timeoutError, V1 } from "../helpers/fetch.js";
import { ACCESS_TOKEN, conversation, contact, createFakeServer, makeCtx, message, textOf } from "../helpers/server.js";

type Level = "read_only" | "read_write" | "full";

function setup(level: Level = "read_write") {
  const fake = createFakeServer();
  registerConversationWriteTools(fake.server, makeCtx(), level);
  return fake;
}

const BASE = `${V1}/conversations/42`;

describe("registerConversationWriteTools", () => {
  describe("正常系", () => {
    it("read_write と full では同じ 4 ツールを登録する", () => {
      const expected = ["chatwoot_send_message", "chatwoot_add_private_note", "chatwoot_update_conversation", "chatwoot_create_conversation"];
      expect(setup("read_write").names()).toEqual(expected);
      expect(setup("full").names()).toEqual(expected);
    });

    it("作成系は CREATE、既存を上書きする更新は destructiveHint 付きの注釈にする", () => {
      const { tools } = setup();
      expect(tools.get("chatwoot_send_message")!.config.annotations).toEqual(CREATE_ANNOTATIONS);
      expect(tools.get("chatwoot_add_private_note")!.config.annotations).toEqual(CREATE_ANNOTATIONS);
      expect(tools.get("chatwoot_create_conversation")!.config.annotations).toEqual(CREATE_ANNOTATIONS);
      expect(tools.get("chatwoot_update_conversation")!.config.annotations).toEqual(DESTRUCTIVE_ANNOTATIONS);
      expect(DESTRUCTIVE_ANNOTATIONS.destructiveHint).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: read_only では何も登録しない（許可されないツールは一覧に出さない）", () => {
      expect(setup("read_only").names()).toEqual([]);
    });
  });
});

describe("chatwoot_send_message", () => {
  describe("正常系", () => {
    it("POST /conversations/{#番号}/messages に outgoing・private=false（既定）で送る", async () => {
      const { calls } = installFetch(routes({ [`POST ${BASE}/messages`]: { json: message({ id: 7, message_type: 1, content: "返信" }) } }));
      const result = await setup().call("chatwoot_send_message", { conversation_id: 42, content: " 返信 " });
      expect(callKeys(calls)).toEqual([`POST ${BASE}/messages`]);
      expect(calls[0]!.body).toEqual({ content: "返信", message_type: "outgoing", private: false });
      expect(textOf(result)).toContain("Message sent in conversation #42");
    });

    it("private=true は社内メモとして送る", async () => {
      const { calls } = installFetch(() => ({ json: message({ private: true }) }));
      const result = await setup().call("chatwoot_send_message", { conversation_id: 42, content: "memo", private: true });
      expect(calls[0]!.body).toMatchObject({ private: true });
      expect(textOf(result)).toContain("Private note added");
    });
  });

  describe("異常系", () => {
    it("空入力: 空白だけの本文は入力検証で拒否し、送信しない", async () => {
      const { calls } = installFetch(() => ({ json: message() }));
      await expect(setup().call("chatwoot_send_message", { conversation_id: 42, content: "   " })).rejects.toThrow();
      await expect(setup().call("chatwoot_send_message", { conversation_id: 42 })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("入力: 20,001 文字以上の本文は入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_send_message", { conversation_id: 42, content: "x".repeat(20_001) })).rejects.toThrow();
    });

    it("サーバ: 404 は #番号の探し方を案内する", async () => {
      installFetch(() => ({ status: 404, json: { error: "x" } }));
      expect(textOf(await setup().call("chatwoot_send_message", { conversation_id: 42, content: "x" }))).toContain(CONVERSATION_NOT_FOUND);
    });

    it("サーバ: 通信失敗は送信済みとして返さず isError にし、トークンを含めない", async () => {
      installFetchFailure(networkError());
      const result = await setup().call("chatwoot_send_message", { conversation_id: 42, content: "x" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).not.toContain("Message sent");
      expect(textOf(result)).not.toContain(ACCESS_TOKEN);
    });
  });
});

describe("chatwoot_add_private_note", () => {
  describe("正常系", () => {
    it("常に private=true で送る", async () => {
      const { calls } = installFetch(routes({ [`POST ${BASE}/messages`]: { json: message({ id: 8, private: true, message_type: 1 }) } }));
      const result = await setup().call("chatwoot_add_private_note", { conversation_id: 42, content: "Triage: billing" });
      expect(calls[0]!.body).toEqual({ content: "Triage: billing", message_type: "outgoing", private: true });
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain("Private note added in conversation #42");
    });
  });

  describe("異常系", () => {
    it("入力: 入力に private を持たず、渡すと入力検証で拒否する", async () => {
      const { calls } = installFetch(() => ({ json: message({ private: true }) }));
      await expect(setup().call("chatwoot_add_private_note", { conversation_id: 42, content: "x", private: false })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("空入力: 空の本文は入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_add_private_note", { conversation_id: 42, content: "" })).rejects.toThrow();
    });

    it("サーバ: Chatwoot が private でないメッセージとして記録したら、成功として返さずに知らせる", async () => {
      installFetch(() => ({ json: message({ id: 9, private: false }) }));
      const result = await setup().call("chatwoot_add_private_note", { conversation_id: 42, content: "x" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("as a non-private message");
    });

    it("サーバ: 応答に private がない（想定外の形）ときも成功として返さない", async () => {
      installFetch(() => ({ json: { id: 10, content: "x", message_type: 1 } }));
      const result = await setup().call("chatwoot_add_private_note", { conversation_id: 42, content: "x" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("as a non-private message");
    });

    it("サーバ: 401（権限不足）は isError で返す", async () => {
      installFetch(() => ({ status: 401, json: { error: "You are not authorized to do this action" } }));
      expect(textOf(await setup().call("chatwoot_add_private_note", { conversation_id: 42, content: "x" }))).toContain("Permission denied");
    });
  });
});

describe("chatwoot_update_conversation", () => {
  function updateRoutes(after: Record<string, unknown> = conversation()) {
    return routes({
      [`POST ${BASE}/toggle_status`]: { json: {} },
      [`POST ${BASE}/toggle_priority`]: { json: {} },
      [`POST ${BASE}/assignments`]: { json: {} },
      [`GET ${BASE}/labels`]: { json: { payload: ["a", "b"] } },
      [`POST ${BASE}/labels`]: (call) => ({ json: { payload: (call.body as { labels: string[] }).labels } }),
      [`POST ${BASE}/custom_attributes`]: { json: {} },
      [`POST ${BASE}/destroy_custom_attributes`]: { json: {} },
      [`GET ${BASE}`]: { json: after },
    });
  }

  describe("正常系", () => {
    it("状態 → 優先度 → チーム → 担当者 → ラベル → 属性の順に POST し、最後に会話を読み直す（PUT は使わない）", async () => {
      const after = conversation({ meta: { sender: contact(), channel: null, assignee: { id: 5 }, team: { id: 2, name: "sales" } } });
      const { calls } = installFetch(updateRoutes(after));
      const result = await setup().call("chatwoot_update_conversation", {
        conversation_id: 42,
        status: "resolved",
        priority: "urgent",
        team_id: 2,
        assignee_id: 5,
        labels: { add: ["c"] },
        custom_attributes: { plan: "pro" },
        remove_custom_attributes: ["old"],
        response_format: "json",
      });
      expect(callKeys(calls)).toEqual([
        `POST ${BASE}/toggle_status`,
        `POST ${BASE}/toggle_priority`,
        `POST ${BASE}/assignments`,
        `POST ${BASE}/assignments`,
        `GET ${BASE}/labels`,
        `POST ${BASE}/labels`,
        `POST ${BASE}/custom_attributes`,
        `POST ${BASE}/destroy_custom_attributes`,
        `GET ${BASE}`,
      ]);
      expect(calls.map((call) => call.method)).not.toContain("PUT");
      expect(calls.map((call) => call.body)).toEqual([
        { status: "resolved" },
        { priority: "urgent" },
        { team_id: 2 },
        { assignee_id: 5 },
        undefined,
        { labels: ["a", "b", "c"] },
        { custom_attributes: { plan: "pro" }, merge: true },
        { custom_attributes: ["old"] },
        undefined,
      ]);
      const structured = result.structuredContent as any;
      expect(structured.applied).toEqual(["status", "priority", "team", "assignee", "labels", "custom_attributes", "remove_custom_attributes"]);
      expect(structured).not.toHaveProperty("warnings");
    });

    it("指定した項目だけを変更する", async () => {
      const { calls } = installFetch(updateRoutes());
      await setup().call("chatwoot_update_conversation", { conversation_id: 42, status: "open" });
      expect(callKeys(calls)).toEqual([`POST ${BASE}/toggle_status`, `GET ${BASE}`]);
    });

    it("snoozed_until は Unix 秒にして toggle_status に渡す", async () => {
      const { calls } = installFetch(updateRoutes());
      await setup().call("chatwoot_update_conversation", { conversation_id: 42, status: "snoozed", snoozed_until: "2026-09-17T09:00:00+09:00" });
      expect(calls[0]!.body).toEqual({ status: "snoozed", snoozed_until: Date.parse("2026-09-17T09:00:00+09:00") / 1000 });
    });

    it("priority=none は null、team_id=null は 0（チームを外す）で送る", async () => {
      const { calls } = installFetch(updateRoutes());
      await setup().call("chatwoot_update_conversation", { conversation_id: 42, priority: "none", team_id: null });
      expect(calls[0]!.body).toEqual({ priority: null });
      expect(calls[1]!.body).toEqual({ team_id: 0 });
    });

    it("ラベルの add / remove は現在のラベルから計算して全置き換えで送る", async () => {
      const { calls } = installFetch(updateRoutes());
      await setup().call("chatwoot_update_conversation", { conversation_id: 42, labels: { add: ["c", "a"], remove: ["b"] } });
      expect(calls.find((call) => call.method === "POST" && call.path === `${BASE}/labels`)!.body).toEqual({ labels: ["a", "c"] });
    });

    it("空入力: ラベルの set=[] は現在値を読まずに空配列で送る（全ラベルの解除）", async () => {
      const { calls } = installFetch(updateRoutes());
      await setup().call("chatwoot_update_conversation", { conversation_id: 42, labels: { set: [] } });
      expect(callKeys(calls)).toEqual([`POST ${BASE}/labels`, `GET ${BASE}`]);
      expect(calls[0]!.body).toEqual({ labels: [] });
    });

    it("空入力: 空の custom_attributes も変更として送る", async () => {
      const { calls } = installFetch(updateRoutes());
      await setup().call("chatwoot_update_conversation", { conversation_id: 42, custom_attributes: {} });
      expect(calls[0]!.body).toEqual({ custom_attributes: {}, merge: true });
    });

    it("担当者・チームが反映されなかった（チーム変更で外れた等）ときは警告を返す", async () => {
      const after = conversation({ meta: { sender: contact(), channel: null, assignee: null, team: { id: 3, name: "other" } } });
      installFetch(updateRoutes(after));
      const result = await setup().call("chatwoot_update_conversation", { conversation_id: 42, team_id: 2, assignee_id: 5 });
      const warnings = (result.structuredContent as any).warnings as string[];
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("assignee is now unassigned, not 5");
      expect(warnings[1]).toBe("team is now 3, not 2.");
      expect(textOf(result)).toContain("Warning: assignee is now unassigned");
    });
  });

  describe("異常系", () => {
    it("入力: snoozed 以外で snoozed_until を渡すと API を呼ばずに拒否する", async () => {
      const { calls } = installFetch(updateRoutes());
      const result = await setup().call("chatwoot_update_conversation", { conversation_id: 42, status: "open", snoozed_until: "2026-09-17" });
      expect(calls).toHaveLength(0);
      expect(textOf(result)).toBe("Error: snoozed_until can only be used with status='snoozed'.");
    });

    it("空入力: 変更する項目がなければ API を呼ばずに拒否する", async () => {
      const { calls } = installFetch(updateRoutes());
      const result = await setup().call("chatwoot_update_conversation", { conversation_id: 42 });
      expect(calls).toHaveLength(0);
      expect(result.isError).toBe(true);
    });

    it("入力: ラベルの set と add を同時に渡すと入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_update_conversation", { conversation_id: 42, labels: { set: ["a"], add: ["b"] } })).rejects.toThrow();
    });

    it("入力: 存在しない日付（13 月・2 月 30 日）の snoozed_until は API を呼ばずに isError の結果で止める", async () => {
      const { calls } = installFetch(updateRoutes());
      for (const snoozed_until of ["2026-13-01", "2026-02-30", "2026-02-30T09:00:00+09:00"]) {
        const result = await setup().call("chatwoot_update_conversation", { conversation_id: 42, status: "snoozed", snoozed_until });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`Invalid date '${snoozed_until}'`);
      }
      expect(calls).toHaveLength(0);
    });

    it("サーバ: 途中の手順が失敗したら以降を実行せず、適用済みの手順（巻き戻さない）を伝える", async () => {
      const { calls } = installFetch(
        routes({
          [`POST ${BASE}/toggle_status`]: { json: {} },
          [`POST ${BASE}/toggle_priority`]: { status: 422, json: { error: "invalid priority" } },
        }),
      );
      const result = await setup().call("chatwoot_update_conversation", { conversation_id: 42, status: "resolved", priority: "high", team_id: 2 });
      expect(callKeys(calls)).toEqual([`POST ${BASE}/toggle_status`, `POST ${BASE}/toggle_priority`]);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "Step 'priority' failed: Error: Chatwoot rejected the request (invalid priority). Fix the listed fields or parameters and retry.\n" +
          "Already applied (not rolled back): status.",
      );
    });

    it("サーバ: 最初の手順で失敗したら「nothing」と伝える", async () => {
      installFetch(() => ({ status: 404, json: { error: "gone" } }));
      const text = textOf(await setup().call("chatwoot_update_conversation", { conversation_id: 42, status: "resolved" }));
      expect(text).toContain(CONVERSATION_NOT_FOUND);
      expect(text).toContain("Already applied (not rolled back): nothing.");
    });

    it("サーバ: ラベルの現在値の取得が通信失敗なら、ラベルの手順で止める", async () => {
      installFetchFailure(networkError());
      const text = textOf(await setup().call("chatwoot_update_conversation", { conversation_id: 42, labels: { add: ["x"] } }));
      expect(text).toContain("Step 'labels' failed: Error: Could not reach Chatwoot");
      expect(text).not.toContain(ACCESS_TOKEN);
    });

    it("サーバ: 更新後の読み直しに失敗したら、適用済みの手順とともにエラーを返す", async () => {
      installFetch(routes({ [`POST ${BASE}/toggle_status`]: { json: {} }, [`GET ${BASE}`]: { status: 500, json: {} } }));
      const result = await setup().call("chatwoot_update_conversation", { conversation_id: 42, status: "resolved" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Updated (status), but re-reading the conversation failed");
    });
  });
});

describe("LabelChangeSchema", () => {
  describe("正常系", () => {
    it("add と remove は同時に指定できる", () => {
      expect(LabelChangeSchema.safeParse({ add: ["b"], remove: ["c"] }).success).toBe(true);
    });

    it("空入力: 空オブジェクト・set=[] は受け付ける", () => {
      expect(LabelChangeSchema.safeParse({}).success).toBe(true);
      expect(LabelChangeSchema.safeParse({ set: [] }).success).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: set と add / remove を同時には指定できない", () => {
      expect(LabelChangeSchema.safeParse({ set: ["a"], add: ["b"] }).success).toBe(false);
      expect(LabelChangeSchema.safeParse({ set: ["a"], remove: ["b"] }).success).toBe(false);
    });

    it("入力: 未知のキーは拒否する", () => {
      expect(LabelChangeSchema.safeParse({ replace: ["a"] }).success).toBe(false);
    });
  });
});

describe("chatwoot_create_conversation", () => {
  describe("正常系", () => {
    it("POST /conversations に初回メッセージを message.content で包んで送る", async () => {
      const { calls } = installFetch(
        routes({
          [`POST ${V1}/conversations`]: { json: { id: 999, display_id: 42 } },
          [`GET ${BASE}`]: { json: conversation() },
        }),
      );
      await setup().call("chatwoot_create_conversation", {
        inbox_id: 3,
        contact_id: 12,
        message: "ご提案の件",
        additional_attributes: { mail_subject: "ご提案" },
      });
      expect(calls[0]!.body).toEqual({ inbox_id: 3, contact_id: 12, additional_attributes: { mail_subject: "ご提案" }, message: { content: "ご提案の件" } });
      expect(calls[0]!.body).not.toHaveProperty("response_format");
    });

    it("作成応答の内部 ID ではなく display_id（#番号）で会話を読み直す", async () => {
      const { calls } = installFetch(
        routes({
          [`POST ${V1}/conversations`]: { json: { id: 999, display_id: 42 } },
          [`GET ${BASE}`]: { json: conversation() },
        }),
      );
      const result = await setup().call("chatwoot_create_conversation", { inbox_id: 3, contact_id: 12 });
      expect(callKeys(calls)).toEqual([`POST ${V1}/conversations`, `GET ${BASE}`]);
      expect((result.structuredContent as any).conversation.id).toBe(42);
      expect(textOf(result)).toContain("Created conversation #42");
    });

    it("display_id がない応答では id で読み直す", async () => {
      const { calls } = installFetch(routes({ [`POST ${V1}/conversations`]: { json: { id: 42 } }, [`GET ${BASE}`]: { json: conversation() } }));
      await setup().call("chatwoot_create_conversation", { inbox_id: 3, contact_id: 12 });
      expect(calls[1]!.path).toBe(BASE);
    });

    it("空入力: message を省略したら message キーを送らない", async () => {
      const { calls } = installFetch(routes({ [`POST ${V1}/conversations`]: { json: { id: 1, display_id: 42 } }, [`GET ${BASE}`]: { json: conversation() } }));
      await setup().call("chatwoot_create_conversation", { inbox_id: 3, contact_id: 12, status: "pending" });
      expect(calls[0]!.body).toEqual({ inbox_id: 3, contact_id: 12, status: "pending" });
    });
  });

  describe("異常系", () => {
    it("空入力: inbox_id・contact_id がないと入力検証で拒否し、API を呼ばない", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await expect(setup().call("chatwoot_create_conversation", {})).rejects.toThrow();
      await expect(setup().call("chatwoot_create_conversation", { inbox_id: 3, contact_id: 12, message: "  " })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("入力: 作成時に使えない状態（snoozed）は入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_create_conversation", { inbox_id: 3, contact_id: 12, status: "snoozed" })).rejects.toThrow();
    });

    it("サーバ: 422（連絡先が受信箱に届かない等）は拒否理由と、inbox_id / contact_id の確認を案内する", async () => {
      installFetch(() => ({ status: 422, json: { error: "Contact inbox not found" } }));
      const result = await setup().call("chatwoot_create_conversation", { inbox_id: 3, contact_id: 12 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Contact inbox not found");
    });

    it("サーバ: 作成後の読み直しがタイムアウトしたら isError で返す", async () => {
      // 作成は成功し、読み直し（GET）だけがタイムアウトする
      const { calls } = installFetch(
        routes({
          [`POST ${V1}/conversations`]: { json: { id: 1, display_id: 42 } },
          [`GET ${BASE}`]: () => {
            throw timeoutError();
          },
        }),
      );
      const result = await setup().call("chatwoot_create_conversation", { inbox_id: 3, contact_id: 12 });
      expect(callKeys(calls)).toEqual([`POST ${V1}/conversations`, `GET ${BASE}`]);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("did not respond within");
    });

    // 再試行で会話が二重にでき、message 付きなら顧客に同じ文面が二度届くため、作成済みと分かる文面にする
    it("サーバ: 作成後の読み直しに失敗したら、作成済みの #番号と、作り直さず get で確かめるよう伝える", async () => {
      installFetch(
        routes({
          [`POST ${V1}/conversations`]: { json: { id: 999, display_id: 42 } },
          [`GET ${BASE}`]: { status: 500, json: { error: "boom" } },
        }),
      );
      const result = await setup().call("chatwoot_create_conversation", { inbox_id: 3, contact_id: 12, message: "ご提案の件" });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toMatch(/^Created conversation #42, but re-reading it failed: Error: Chatwoot server error \(500\)/);
      expect(text).toContain("Do not create it again; check it with chatwoot_get_conversation conversation_id=42.");
    });

    it("サーバ: 作成応答に #番号も id もないときは、通信失敗とは言わず、作成済みの可能性と一覧での確認を伝える", async () => {
      const { calls } = installFetch(routes({ [`POST ${V1}/conversations`]: { json: {} } }));
      const result = await setup().call("chatwoot_create_conversation", { inbox_id: 3, contact_id: 12 });
      expect(callKeys(calls)).toEqual([`POST ${V1}/conversations`]);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("The conversation was probably created; do not create it again.");
      expect(textOf(result)).toContain("chatwoot_list_conversations");
      expect(textOf(result)).not.toContain("Could not reach");
    });
  });
});
