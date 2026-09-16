/**
 * 確認項目。
 *   - readChecks : Chatwoot の状態を変えない確認（既定）
 *   - writeChecks: テスト用のデータを作って一連の運用（問い合わせ対応）を再現し、最後に消す（--write）
 */
import { LISTABLE } from "../../src/resources.js";
import { check, expectError, expectField, expectOk, field, listToolNames, type Harness } from "./harness.mts";

/** 作成するデータの名前に付ける印。途中で失敗しても、後から人が見分けられるようにする */
const PREFIX = "mcp-verify";

const WRITE_TOOLS = ["chatwoot_send_message", "chatwoot_create_contact", "chatwoot_update_conversation", "chatwoot_create_record"];
const DELETE_TOOLS = ["chatwoot_delete_record", "chatwoot_delete_contact", "chatwoot_delete_message", "chatwoot_merge_contacts"];

export async function readChecks(harness: Harness): Promise<void> {
  console.log("\n[1] ツール定義");

  await harness.step("すべてのツールに説明・入力スキーマ・注釈がある", async () => {
    const tools = await harness.listTools();
    check(tools.length > 0, "ツールが 1 つも登録されていません");
    for (const tool of tools) {
      check((tool.description ?? "").length >= 40, `${tool.name}: description が短すぎます`);
      check(tool.inputSchema !== undefined, `${tool.name}: inputSchema がありません`);
      check(tool.annotations?.readOnlyHint !== undefined, `${tool.name}: annotations がありません`);
    }
  });

  await harness.step("CHATWOOT_ACCESS_LEVEL でツールの公開範囲が変わる", async () => {
    const [readOnly, readWrite, full] = await Promise.all([listToolNames("read_only"), listToolNames("read_write"), listToolNames("full")]);

    for (const name of readOnly) check(readWrite.includes(name), `read_write に ${name} がありません（read_only の上位集合であるべき）`);
    for (const name of readWrite) check(full.includes(name), `full に ${name} がありません（read_write の上位集合であるべき）`);

    for (const name of [...WRITE_TOOLS, ...DELETE_TOOLS]) {
      check(!readOnly.includes(name), `read_only に書き込みツール ${name} が公開されています`);
    }
    for (const name of WRITE_TOOLS) check(readWrite.includes(name), `read_write に ${name} がありません`);
    for (const name of DELETE_TOOLS) {
      check(!readWrite.includes(name), `read_write に削除ツール ${name} が公開されています`);
      check(full.includes(name), `full に ${name} がありません`);
    }
  });

  console.log("\n[2] 接続とアカウント");

  const account = await harness.call("chatwoot_get_account");
  await harness.step("chatwoot_get_account が設定どおりのアカウントを返す", async () => {
    expectOk(account, "chatwoot_get_account");
    expectField(account, "account.id", Number(process.env.CHATWOOT_ACCOUNT_ID ?? 1), "chatwoot_get_account");
    expectField(account, "access_level", harness.accessLevel, "chatwoot_get_account");
    check(typeof field(account, "user.id", "chatwoot_get_account") === "number", "接続ユーザーの ID が取れません");
  });

  const isAdministrator = field(account, "user.role", "chatwoot_get_account") === "administrator";

  console.log("\n[3] 一覧・検索");

  await harness.step("chatwoot_list_conversations が件数付きで返る", async () => {
    const result = expectOk(await harness.call("chatwoot_list_conversations", { status: "all" }), "chatwoot_list_conversations");
    check(typeof field(result, "counts.all_count", "chatwoot_list_conversations") === "number", "counts.all_count がありません");
  });

  await harness.step("存在しないページを指定しても空で返る", async () => {
    const result = expectOk(await harness.call("chatwoot_list_conversations", { status: "all", page: 9_999 }), "page=9999");
    expectField(result, "count", 0, "page=9999");
    expectField(result, "has_more", false, "page=9999");
  });

  await harness.step("chatwoot_list_contacts が返る", async () => {
    expectOk(await harness.call("chatwoot_list_contacts"), "chatwoot_list_contacts");
  });

  await harness.step(`chatwoot_list_records が全 ${LISTABLE.length} リソースで返る`, async () => {
    for (const resource of LISTABLE) {
      expectOk(await harness.call("chatwoot_list_records", { resource }), `chatwoot_list_records resource=${resource}`);
    }
  });

  console.log("\n[4] レポート");

  for (const [name, args] of [
    ["chatwoot_get_report_summary", { since: "2026-01-01" }],
    ["chatwoot_get_live_conversation_stats", {}],
    ["chatwoot_get_report_timeseries", { metric: "conversations_count", since: "2026-01-01", group_by: "month" }],
    ["chatwoot_get_report_breakdown", { kind: "by_agent", since: "2026-01-01" }],
  ] as const) {
    if (!isAdministrator) {
      harness.skip(`${name} が返る`, "接続ユーザーが管理者ではありません");
      continue;
    }
    await harness.step(`${name} が返る`, async () => {
      expectOk(await harness.call(name, args), name);
    });
  }

  console.log("\n[5] エラーの扱い");

  await harness.step("存在しない会話 ID は次の手順を示すエラーになる", async () => {
    const result = await harness.call("chatwoot_get_conversation", { conversation_id: 999_999 });
    expectError(result, /Not found.*chatwoot_list_conversations/s, "chatwoot_get_conversation");
  });

  await harness.step("取得 API のないリソースでも存在しない ID を検出する", async () => {
    const result = await harness.call("chatwoot_get_record", { resource: "canned_responses", id: 999_999 });
    expectError(result, /Not found/, "chatwoot_get_record");
  });

  await harness.step("未知の属性キーのフィルタは Chatwoot の指摘をそのまま返す", async () => {
    const result = await harness.call("chatwoot_filter_conversations", {
      conditions: [{ attribute_key: "not_a_key", filter_operator: "equal_to", values: ["x"] }],
    });
    expectError(result, /rejected the request/, "chatwoot_filter_conversations");
  });

  await harness.step("ありえない日付は Chatwoot に送る前に弾く", async () => {
    const result = await harness.call("chatwoot_get_report_timeseries", { metric: "conversations_count", since: "2026-13-45" });
    expectError(result, /Invalid date/, "chatwoot_get_report_timeseries");
  });

  await harness.step("関連データの組み合わせが誤っていれば候補を示す", async () => {
    const result = await harness.call("chatwoot_get_related", { resource: "team", id: 1, relation: "agent_bot" });
    expectError(result, /Valid relations: members/, "chatwoot_get_related");
  });
}

export async function writeChecks(harness: Harness): Promise<void> {
  const suffix = `${Date.now().toString(36)}`;
  const account = expectOk(await harness.call("chatwoot_get_account"), "chatwoot_get_account");
  const userId = field(account, "user.id", "chatwoot_get_account") as number;

  console.log("\n[6] 受信箱・ラベル・チームの作成");

  let inboxId = 0;
  await harness.step("API 受信箱を用意する", async () => {
    const existing = expectOk(await harness.call("chatwoot_list_records", { resource: "inboxes" }), "inboxes");
    const items = field(existing, "items", "inboxes") as { id: number; channel_type?: string }[];
    const apiInbox = items.find((item) => item.channel_type === "Channel::Api");
    if (apiInbox) {
      inboxId = apiInbox.id;
      return;
    }
    const created = expectOk(
      await harness.call("chatwoot_create_record", { resource: "inboxes", data: { name: `${PREFIX}-inbox-${suffix}`, channel: { type: "api" } } }),
      "受信箱の作成",
    );
    inboxId = field(created, "record.id", "受信箱の作成") as number;
    // 受信箱の削除ツールは（運用で使う場面がないため）用意していないので、後片付けだけ REST API で行う
    harness.defer(`受信箱 ${inboxId}`, () => deleteViaRest(`/inboxes/${inboxId}`));
  });

  const labelTitle = `${PREFIX}-${suffix}`;
  await harness.step("ラベルを作成する", async () => {
    const created = expectOk(
      await harness.call("chatwoot_create_record", { resource: "labels", data: { title: labelTitle, description: "動作確認用", color: "#1F93FF" } }),
      "ラベルの作成",
    );
    const labelId = field(created, "record.id", "ラベルの作成") as number;
    harness.defer(`ラベル ${labelTitle}`, async () => {
      expectOk(await harness.call("chatwoot_delete_record", { resource: "labels", id: labelId }), "ラベルの削除");
    });
  });

  let teamId = 0;
  await harness.step("チームを作成し、自分をメンバーに追加する", async () => {
    const created = expectOk(
      await harness.call("chatwoot_create_record", { resource: "teams", data: { name: `${PREFIX}-team-${suffix}`, description: "動作確認用" } }),
      "チームの作成",
    );
    teamId = field(created, "record.id", "チームの作成") as number;
    harness.defer(`チーム ${teamId}`, async () => {
      expectOk(await harness.call("chatwoot_delete_record", { resource: "teams", id: teamId }), "チームの削除");
    });

    expectOk(await harness.call("chatwoot_set_members", { target: "team", id: teamId, user_ids: [userId], mode: "add" }), "チームへの追加");
    // 担当者にできるのは受信箱のメンバーだけなので、受信箱にも追加しておく
    expectOk(await harness.call("chatwoot_set_members", { target: "inbox", id: inboxId, user_ids: [userId], mode: "add" }), "受信箱への追加");
  });

  console.log("\n[7] コンタクトと会話");

  let contactId = 0;
  await harness.step("コンタクトを作成する", async () => {
    const created = expectOk(
      await harness.call("chatwoot_create_contact", {
        name: `動作確認 ${suffix}`,
        email: `${PREFIX}-${suffix}@example.com`,
        additional_attributes: { company_name: "ComeGin" },
        custom_attributes: { source: PREFIX },
      }),
      "コンタクトの作成",
    );
    contactId = field(created, "contact.id", "コンタクトの作成") as number;
    // コンタクトを消すと、その会話とメッセージも消える
    harness.defer(`コンタクト ${contactId}`, async () => {
      expectOk(await harness.call("chatwoot_delete_contact", { contact_id: contactId }), "コンタクトの削除");
    });
  });

  await harness.step("連絡可能な受信箱に、用意した受信箱が含まれる", async () => {
    const related = expectOk(await harness.call("chatwoot_get_related", { resource: "contact", id: contactId, relation: "contactable_inboxes" }), "contactable_inboxes");
    check(related.text.includes(`"id": ${inboxId}`), `受信箱 ${inboxId} が連絡可能な受信箱に含まれていません`);
  });

  let conversationId = 0;
  await harness.step("会話を作成し、最初のメッセージを送る", async () => {
    const created = expectOk(
      await harness.call("chatwoot_create_conversation", { inbox_id: inboxId, contact_id: contactId, message: "動作確認: 最初のメッセージです。" }),
      "会話の作成",
    );
    conversationId = field(created, "conversation.id", "会話の作成") as number;
    check(conversationId > 0, "会話 ID が取れません");
  });

  await harness.step("社内メモを追加する", async () => {
    const sent = expectOk(await harness.call("chatwoot_send_message", { conversation_id: conversationId, content: "動作確認: 社内メモ", private: true }), "社内メモ");
    expectField(sent, "message.private", true, "社内メモ");
  });

  await harness.step("メッセージ履歴に本文と社内メモが並ぶ", async () => {
    const messages = expectOk(await harness.call("chatwoot_list_messages", { conversation_id: conversationId }), "chatwoot_list_messages");
    const items = field(messages, "messages", "chatwoot_list_messages") as { content?: string; private?: boolean }[];
    check(items.some((message) => message.content?.includes("最初のメッセージ")), "最初のメッセージが履歴にありません");
    check(items.some((message) => message.private === true), "社内メモが履歴にありません");
  });

  console.log("\n[8] 会話の更新");

  await harness.step("状態・優先度・担当・チーム・ラベルをまとめて更新できる", async () => {
    const updated = expectOk(
      await harness.call("chatwoot_update_conversation", {
        conversation_id: conversationId,
        status: "pending",
        priority: "urgent",
        team_id: teamId,
        assignee_id: userId,
        labels: { add: [labelTitle] },
        custom_attributes: { source: PREFIX },
      }),
      "会話の更新",
    );
    // チーム変更で担当者が外れていないこと（Chatwoot はチームに属さない担当者を自動で外す）
    check(updated.structured?.warnings === undefined, `更新が反映されていません: ${JSON.stringify(updated.structured?.warnings)}`);
    expectField(updated, "conversation.status", "pending", "会話の更新");
    expectField(updated, "conversation.priority", "urgent", "会話の更新");
    expectField(updated, "conversation.assignee.id", userId, "会話の更新");
    expectField(updated, "conversation.team.id", teamId, "会話の更新");
  });

  await harness.step("ラベルとカスタム属性を外せる", async () => {
    const updated = expectOk(
      await harness.call("chatwoot_update_conversation", {
        conversation_id: conversationId,
        status: "resolved",
        priority: "none",
        labels: { remove: [labelTitle] },
        remove_custom_attributes: ["source"],
      }),
      "会話の更新（解除）",
    );
    expectField(updated, "conversation.status", "resolved", "会話の更新（解除）");
    check((field(updated, "conversation.labels", "会話の更新（解除）") as string[] | undefined) === undefined, "ラベルが残っています");
    check(updated.structured?.conversation !== undefined, "更新後の会話が返っていません");
  });

  console.log("\n[9] 検索・コンタクト更新・削除");

  await harness.step("フィルタで作成した会話を見つけられる", async () => {
    const filtered = expectOk(
      await harness.call("chatwoot_filter_conversations", {
        conditions: [{ attribute_key: "contact_id", filter_operator: "equal_to", values: [contactId] }],
      }),
      "chatwoot_filter_conversations",
    );
    const items = field(filtered, "items", "chatwoot_filter_conversations") as { id: number }[];
    check(items.some((item) => item.id === conversationId), `会話 #${conversationId} がフィルタ結果にありません`);
  });

  await harness.step("コンタクトのラベルとカスタム属性を更新できる", async () => {
    const updated = expectOk(
      await harness.call("chatwoot_update_contact", { contact_id: contactId, labels: { add: [labelTitle] }, custom_attributes: { source: `${PREFIX}-updated` } }),
      "コンタクトの更新",
    );
    check(updated.text.includes(`${PREFIX}-updated`), "カスタム属性の更新が反映されていません");

    const labels = expectOk(await harness.call("chatwoot_get_related", { resource: "contact", id: contactId, relation: "labels" }), "コンタクトのラベル");
    check(labels.text.includes(labelTitle), "コンタクトにラベルが付いていません");
    // 後片付けでラベルを消せるよう、コンタクトから外しておく
    expectOk(await harness.call("chatwoot_update_contact", { contact_id: contactId, labels: { set: [] } }), "ラベルの解除");
  });

  await harness.step("メッセージを削除できる", async () => {
    const messages = expectOk(await harness.call("chatwoot_list_messages", { conversation_id: conversationId }), "chatwoot_list_messages");
    const items = field(messages, "messages", "chatwoot_list_messages") as { id: number; private?: boolean }[];
    const note = items.find((message) => message.private === true);
    check(note !== undefined, "削除対象の社内メモが見つかりません");
    expectOk(await harness.call("chatwoot_delete_message", { conversation_id: conversationId, message_id: note.id }), "メッセージの削除");
  });

  await harness.step("送信したメッセージがレポートに反映される", async () => {
    const report = expectOk(await harness.call("chatwoot_get_report_breakdown", { kind: "outgoing_messages_by_agent", since: today() }), "レポート");
    check(/outgoing_messages_count": [1-9]/.test(report.text), "本日の送信メッセージ数が 0 のままです");
  });
}

function today(): string {
  const offsetHours = Number(process.env.CHATWOOT_TIMEZONE_OFFSET ?? 9);
  return new Date(Date.now() + offsetHours * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 後片付け専用の直接呼び出し。
 * 受信箱の削除は MCP ツールとして公開していない（誤って会話ごと消す操作を AI に渡さないため）ので、ここだけ REST API を使う
 */
async function deleteViaRest(path: string): Promise<void> {
  const baseUrl = (process.env.CHATWOOT_BASE_URL ?? "").replace(/\/+$/, "");
  const token = process.env.CHATWOOT_API_ACCESS_TOKEN ?? "";
  const accountId = process.env.CHATWOOT_ACCOUNT_ID ?? "1";
  const response = await fetch(`${baseUrl}/api/v1/accounts/${accountId}${path}`, {
    method: "DELETE",
    headers: { api_access_token: token },
  });
  check(response.ok, `DELETE ${path} が ${response.status} を返しました`);
}
