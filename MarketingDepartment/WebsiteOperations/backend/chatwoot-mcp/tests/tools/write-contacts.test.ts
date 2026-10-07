import { describe, expect, it } from "vitest";

import { CREATE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS } from "../../src/tools/annotations.js";
import { CONTACT_NOT_FOUND } from "../../src/tools/contacts.js";
import { registerContactWriteTools } from "../../src/tools/write-contacts.js";
import { callKeys, installFetch, installFetchFailure, networkError, routes, timeoutError, V1 } from "../helpers/fetch.js";
import { ACCESS_TOKEN, contact, createFakeServer, jsonOf, makeCtx, textOf } from "../helpers/server.js";

type Level = "read_only" | "read_write" | "full";

function setup(level: Level = "full") {
  const fake = createFakeServer();
  registerContactWriteTools(fake.server, makeCtx(), level);
  return fake;
}

describe("registerContactWriteTools", () => {
  describe("正常系", () => {
    it("full では統合・削除も登録する", () => {
      expect(setup("full").names()).toEqual([
        "chatwoot_create_contact",
        "chatwoot_update_contact",
        "chatwoot_merge_contacts",
        "chatwoot_delete_contact",
        "chatwoot_delete_message",
      ]);
    });

    it("作成は CREATE、更新・統合・削除は destructiveHint 付きの注釈にする", () => {
      const { tools } = setup();
      expect(tools.get("chatwoot_create_contact")!.config.annotations).toEqual(CREATE_ANNOTATIONS);
      for (const name of ["chatwoot_update_contact", "chatwoot_merge_contacts", "chatwoot_delete_contact", "chatwoot_delete_message"]) {
        expect(tools.get(name)!.config.annotations, name).toEqual(DESTRUCTIVE_ANNOTATIONS);
      }
    });
  });

  describe("異常系", () => {
    it("入力: read_only では何も登録しない", () => {
      expect(setup("read_only").names()).toEqual([]);
    });

    it("入力: read_write では作成・更新だけを登録し、統合・削除は登録しない", () => {
      expect(setup("read_write").names()).toEqual(["chatwoot_create_contact", "chatwoot_update_contact"]);
    });
  });
});

describe("chatwoot_create_contact", () => {
  describe("正常系", () => {
    it("POST /contacts にラベル・出力形式を除いた項目を送り、ラベルを付けてから読み直す", async () => {
      const { calls } = installFetch(
        routes({
          [`POST ${V1}/contacts`]: { json: { payload: { contact: { id: 77 } } } },
          [`POST ${V1}/contacts/77/labels`]: { json: { payload: ["lead"] } },
          [`GET ${V1}/contacts/77`]: { json: { payload: contact({ id: 77 }) } },
        }),
      );
      const result = await setup().call("chatwoot_create_contact", { name: "山田 太郎", email: "taro@example.com", inbox_id: 3, labels: ["lead"] });
      expect(callKeys(calls)).toEqual([`POST ${V1}/contacts`, `POST ${V1}/contacts/77/labels`, `GET ${V1}/contacts/77`]);
      expect(calls[0]!.body).toEqual({ name: "山田 太郎", email: "taro@example.com", inbox_id: 3 });
      expect(calls[1]!.body).toEqual({ labels: ["lead"] });
      expect((result.structuredContent as any).contact.id).toBe(77);
    });

    it("空入力: labels が空配列ならラベル付けを呼ばない", async () => {
      const { calls } = installFetch(
        routes({ [`POST ${V1}/contacts`]: { json: { payload: { contact: { id: 77 } } } }, [`GET ${V1}/contacts/77`]: { json: { payload: contact({ id: 77 }) } } }),
      );
      await setup().call("chatwoot_create_contact", { name: "x", labels: [] });
      expect(callKeys(calls)).toEqual([`POST ${V1}/contacts`, `GET ${V1}/contacts/77`]);
    });
  });

  describe("異常系", () => {
    it("空入力: 名前・メール・電話・identifier のどれもなければ API を呼ばずに拒否する", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      const result = await setup().call("chatwoot_create_contact", { custom_attributes: { plan: "pro" } });
      expect(calls).toHaveLength(0);
      expect(textOf(result)).toBe("Error: give at least one of name, email, phone_number or identifier.");
    });

    it("空入力: 引数がまったくないときも API を呼ばずに拒否する", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      expect((await setup().call("chatwoot_create_contact", {})).isError).toBe(true);
      expect(calls).toHaveLength(0);
    });

    it("入力: 電話番号は E.164 形式に限る", async () => {
      await expect(setup().call("chatwoot_create_contact", { phone_number: "090-1234-5678" })).rejects.toThrow();
    });

    it("入力: メールの形式違反・空白だけの名前は入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_create_contact", { email: "not-an-email" })).rejects.toThrow();
      await expect(setup().call("chatwoot_create_contact", { name: "   " })).rejects.toThrow();
    });

    it("サーバ: 作成後のラベル付けに失敗したら、作成済みの ID とともに知らせる", async () => {
      installFetch(
        routes({
          [`POST ${V1}/contacts`]: { json: { payload: { contact: { id: 77 } } } },
          [`POST ${V1}/contacts/77/labels`]: { status: 422, json: { error: "bad label" } },
        }),
      );
      const result = await setup().call("chatwoot_create_contact", { name: "x", labels: ["Bad Label"] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Created contact 77, but setting labels or re-reading it failed");
    });

    it("サーバ: 重複（422）は Chatwoot の項目名付きで返す", async () => {
      installFetch(() => ({ status: 422, json: { message: "Email has already been taken", attributes: ["email"] } }));
      const result = await setup().call("chatwoot_create_contact", { email: "taro@example.com" });
      expect(textOf(result)).toContain("Email has already been taken (fields: email)");
    });

    it("サーバ: 作成が通信失敗なら isError で返し、トークンを含めない", async () => {
      installFetchFailure(networkError());
      const result = await setup().call("chatwoot_create_contact", { name: "x" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Could not reach Chatwoot");
      expect(textOf(result)).not.toContain(ACCESS_TOKEN);
    });

    it("サーバ: 作成応答が想定外の形（payload.contact なし）でも例外にせず isError で返す", async () => {
      installFetch(routes({ [`POST ${V1}/contacts`]: { json: { id: 77 } } }));
      expect((await setup().call("chatwoot_create_contact", { name: "x" })).isError).toBe(true);
    });

    // 再試行で、メールも identifier もない連絡先が重複して作られないよう、通信失敗とは言わずに確認を促す
    it("サーバ: 作成応答から ID を取り出せないときは、作成済みの可能性と、再試行の前に一覧で確かめるよう伝える", async () => {
      for (const json of [{ id: 77 }, { payload: null }, { payload: { contact: {} } }, null]) {
        const { calls } = installFetch(routes({ [`POST ${V1}/contacts`]: { json } }));
        const result = await setup().call("chatwoot_create_contact", { name: "x" });
        expect(callKeys(calls)).toEqual([`POST ${V1}/contacts`]);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("The contact may have been created; search with chatwoot_list_contacts");
        expect(textOf(result)).not.toContain("Could not reach");
      }
    });
  });
});

describe("chatwoot_update_contact", () => {
  describe("正常系", () => {
    it("項目は PUT /contacts/{id}（Chatwoot の update アクション。存在しない ID は 404 で新規作成しない）に、指定した項目だけを送る", async () => {
      const { calls } = installFetch(routes({ [`PUT ${V1}/contacts/12`]: { json: {} }, [`GET ${V1}/contacts/12`]: { json: { payload: contact() } } }));
      const result = await setup().call("chatwoot_update_contact", { contact_id: 12, additional_attributes: { company_name: "Example" } });
      expect(callKeys(calls)).toEqual([`PUT ${V1}/contacts/12`, `GET ${V1}/contacts/12`]);
      expect(calls[0]!.body).toEqual({ additional_attributes: { company_name: "Example" } });
      expect((result.structuredContent as any).applied).toEqual(["fields"]);
    });

    it("ラベルだけの変更では項目の更新を呼ばない", async () => {
      const { calls } = installFetch(
        routes({
          [`GET ${V1}/contacts/12/labels`]: { json: { payload: ["old"] } },
          [`POST ${V1}/contacts/12/labels`]: { json: { payload: [] } },
          [`GET ${V1}/contacts/12`]: { json: { payload: contact() } },
        }),
      );
      await setup().call("chatwoot_update_contact", { contact_id: 12, labels: { add: ["lead"] } });
      expect(callKeys(calls)).toEqual([`GET ${V1}/contacts/12/labels`, `POST ${V1}/contacts/12/labels`, `GET ${V1}/contacts/12`]);
      expect(calls[1]!.body).toEqual({ labels: ["old", "lead"] });
    });

    it("remove_custom_attributes は destroy_custom_attributes に送る", async () => {
      const { calls } = installFetch(
        routes({ [`POST ${V1}/contacts/12/destroy_custom_attributes`]: { json: {} }, [`GET ${V1}/contacts/12`]: { json: { payload: contact() } } }),
      );
      await setup().call("chatwoot_update_contact", { contact_id: 12, remove_custom_attributes: ["plan"] });
      expect(calls[0]!.body).toEqual({ custom_attributes: ["plan"] });
    });

    it("空入力: labels の set=[] は全ラベルを外す（現在値は読まない）", async () => {
      const { calls } = installFetch(
        routes({ [`POST ${V1}/contacts/12/labels`]: { json: { payload: [] } }, [`GET ${V1}/contacts/12`]: { json: { payload: contact() } } }),
      );
      await setup().call("chatwoot_update_contact", { contact_id: 12, labels: { set: [] } });
      expect(callKeys(calls)).toEqual([`POST ${V1}/contacts/12/labels`, `GET ${V1}/contacts/12`]);
      expect(calls[0]!.body).toEqual({ labels: [] });
    });
  });

  describe("異常系", () => {
    it("空入力: 変更する項目がなければ API を呼ばずに拒否する", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      expect(textOf(await setup().call("chatwoot_update_contact", { contact_id: 12 }))).toBe("Error: nothing to update.");
      expect(calls).toHaveLength(0);
    });

    it("入力: contact_id がない・電話番号が E.164 でないと入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_update_contact", { name: "x" })).rejects.toThrow();
      await expect(setup().call("chatwoot_update_contact", { contact_id: 12, phone_number: "0312345678" })).rejects.toThrow();
    });

    it("サーバ: 途中で失敗したら適用済みの手順を伝える", async () => {
      installFetch(routes({ [`PUT ${V1}/contacts/12`]: { json: {} }, [`GET ${V1}/contacts/12/labels`]: { status: 500, json: {} } }));
      const text = textOf(await setup().call("chatwoot_update_contact", { contact_id: 12, name: "x", labels: { add: ["a"] } }));
      expect(text).toContain("Step 'labels' failed");
      expect(text).toContain("Already applied (not rolled back): fields.");
    });

    it("サーバ: 最初の手順が 404 なら連絡先の探し方を案内し、適用済みは nothing", async () => {
      installFetch(() => ({ status: 404, json: { error: "x" } }));
      const text = textOf(await setup().call("chatwoot_update_contact", { contact_id: 99, name: "x" }));
      expect(text).toContain(CONTACT_NOT_FOUND);
      expect(text).toContain("Already applied (not rolled back): nothing.");
    });

    it("サーバ: 更新後の読み直しに失敗したら、適用済みの手順とともにエラーを返す", async () => {
      installFetch(routes({ [`PUT ${V1}/contacts/12`]: { json: {} }, [`GET ${V1}/contacts/12`]: { status: 503, json: {} } }));
      const text = textOf(await setup().call("chatwoot_update_contact", { contact_id: 12, name: "x" }));
      expect(text).toContain("Updated (fields), but re-reading the contact failed");
    });
  });
});

describe("chatwoot_merge_contacts", () => {
  describe("正常系", () => {
    it("POST /actions/contact_merge に残す側と統合される側を送る", async () => {
      const { calls } = installFetch(routes({ [`POST ${V1}/actions/contact_merge`]: { json: contact({ id: 1 }) } }));
      const result = await setup().call("chatwoot_merge_contacts", { base_contact_id: 1, mergee_contact_id: 2 });
      expect(calls[0]!.body).toEqual({ base_contact_id: 1, mergee_contact_id: 2 });
      expect(jsonOf(result)).toMatchObject({ merged_into: 1, deleted: 2 });
    });
  });

  describe("異常系", () => {
    it("入力: 同じ ID 同士は API を呼ばずに拒否する", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      const result = await setup().call("chatwoot_merge_contacts", { base_contact_id: 3, mergee_contact_id: 3 });
      expect(calls).toHaveLength(0);
      expect(result.isError).toBe(true);
    });

    it("空入力: mergee_contact_id がないと入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_merge_contacts", { base_contact_id: 3 })).rejects.toThrow();
    });

    it("サーバ: 404 は連絡先の探し方を案内する", async () => {
      installFetch(() => ({ status: 404, json: { error: "x" } }));
      expect(textOf(await setup().call("chatwoot_merge_contacts", { base_contact_id: 1, mergee_contact_id: 2 }))).toContain(CONTACT_NOT_FOUND);
    });
  });
});

describe("chatwoot_delete_contact", () => {
  describe("正常系", () => {
    it("DELETE /contacts/{id} を呼ぶ", async () => {
      const { calls } = installFetch(() => ({ text: "" }));
      const result = await setup().call("chatwoot_delete_contact", { contact_id: 12 });
      expect(callKeys(calls)).toEqual([`DELETE ${V1}/contacts/12`]);
      expect(jsonOf(result)).toEqual({ deleted: "contact", id: 12 });
    });
  });

  describe("異常系", () => {
    it("空入力: contact_id がないと入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_delete_contact", {})).rejects.toThrow();
    });

    it("サーバ: 422（ウィジェットでオンライン中）は拒否理由を返し、削除済みとして返さない", async () => {
      installFetch(() => ({ status: 422, json: { message: "contact is online" } }));
      const result = await setup().call("chatwoot_delete_contact", { contact_id: 12 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("contact is online");
    });
  });
});

describe("chatwoot_delete_message", () => {
  describe("正常系", () => {
    it("DELETE /conversations/{#番号}/messages/{id} を呼ぶ", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      const result = await setup().call("chatwoot_delete_message", { conversation_id: 42, message_id: 7 });
      expect(callKeys(calls)).toEqual([`DELETE ${V1}/conversations/42/messages/7`]);
      expect(jsonOf(result)).toEqual({ deleted: "message", conversation_id: 42, message_id: 7 });
    });
  });

  describe("異常系", () => {
    it("空入力: message_id がないと入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_delete_message", { conversation_id: 42 })).rejects.toThrow();
    });

    it("サーバ: 削除の 404 は ID の探し方を案内する", async () => {
      installFetch(() => ({ status: 404, json: { error: "x" } }));
      expect(textOf(await setup().call("chatwoot_delete_message", { conversation_id: 42, message_id: 7 }))).toContain("Message IDs come from chatwoot_list_messages.");
    });

    it("サーバ: タイムアウトは isError で返す", async () => {
      installFetchFailure(timeoutError());
      expect((await setup().call("chatwoot_delete_message", { conversation_id: 42, message_id: 7 })).isError).toBe(true);
    });
  });
});
