// 通しの結合テスト。公開経路の入口から、Mautic・Chatwoot が自分で署名して送る Webhook を経て、n8n の I-11・I-12 → I-19・I-21 →
// MailHog まで届くことを確かめる（合成の Webhook を送る i11・i12 のテストと違い、署名・本文の形・Raw Body は製品が作る本物）。
//
//   I-08 → I-11 → I-21: Mautic の公開フォーム（/form/submit。無料相談 MAUTIC_FORM_ID_CONSULT）→ Mautic の Webhook「n8n I-11」
//                       （開発の Mautic は queue_mode=immediate_process なので、送信の処理の中で送る。コマンドの実行は要らない）
//   I-07 → I-12 → I-19: Chatwoot のウィジェットの API（website_token）→ Chatwoot の Webhook「n8n I-12」（Sidekiq が非同期に送る）
//
// 親の I-11・I-12 はこのファイルの間だけ有効にする。作ったコンタクト・会話は it- の名前・メールにして、最後に消す。
//
// 2026-10-07 時点の開発スタックでは、どちらの製品も私設アドレス（127.0.0.1・host.docker.internal）への Webhook を SSRF 対策で拒むため、
// 本物の Webhook が n8n に届かない（下の MAUTIC_REACHES_N8N・CHATWOOT_REACHES_N8N）。設定が足りない間は、その経路のテストを
// it.todo にする（設定が直れば、同じファイルのまま実際に走る）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteChatwootContact, deleteChatwootConversation } from "../helpers/chatwoot.ts";
import { Cleanup } from "../helpers/cleanup.ts";
import { requireValue } from "../helpers/env.ts";
import { http } from "../helpers/http.ts";
import { execIn } from "../helpers/docker.ts";
import { deleteContact, findContactsByEmail, mauticApi } from "../helpers/mautic.ts";
import { activateForTest, findWorkflow, setActive } from "../helpers/n8n.ts";
import { itEmail, itName } from "../helpers/run-id.ts";
import { DEV } from "../helpers/services.ts";
import { expectNever, waitFor } from "../helpers/wait.ts";
import { alerts, decodeBody, deleteFormSubmissions, N8nWindow, publishMauticHook, rows, startWidgetConversation, submitMauticForm, waitForList } from "./support.ts";

/**
 * Mautic（5 以降の WebhookBundle/Http/Client.php）は、config/local.php の webhook_allowed_private_addresses に無い私設アドレスへの
 * Webhook を送らない（webhook_logs に "Access to private addresses is not allowed."）。I-11 の送り先は http://127.0.0.1:5678 なので、
 * 127.0.0.1 を含む範囲がこの配列に要る。local.php は秘密値を含むので、この 1 つの配列だけを取り出して見る（値は出さない）
 */
function mauticAllowsLoopback(): boolean {
  try {
    const text = readFileSync(resolve(import.meta.dirname, "../../../backend/mautic-system/config/local.php"), "utf8");
    const block = /'webhook_allowed_private_addresses'\s*=>\s*array\s*\(([^)]*)\)/.exec(text)?.[1] ?? "";
    return /'127\.|'0\.0\.0\.0/.test(block);
  } catch {
    return false;
  }
}

/**
 * Chatwoot の SafeFetch（lib/safe_fetch.rb）は、SAFE_FETCH_ALLOW_PRIVATE_NETWORK が true でないと私設アドレスへの Webhook を
 * 送らない（Sidekiq のログに "Hostname 'host.docker.internal' has no public ip addresses"。失敗を記録するだけで再送しない）
 */
async function chatwootAllowsPrivateNetwork(): Promise<boolean> {
  try {
    return (await execIn("chatwoot-system-sidekiq-1", ["printenv", "SAFE_FETCH_ALLOW_PRIVATE_NETWORK"])).trim() === "true";
  } catch {
    return false;
  }
}

const MAUTIC_REACHES_N8N = mauticAllowsLoopback();
const CHATWOOT_REACHES_N8N = await chatwootAllowsPrivateNetwork();

const n8nWindow = new N8nWindow();
const cleanup = new Cleanup();
const restores: Array<() => Promise<void>> = [];

const consultForm = (email: string, company: string): Record<string, string> => ({
  company,
  lastname: "it",
  firstname: itName("form"),
  email,
  message: itName("message"),
  page_url: "/blog/it-sample",
  privacy_consent_at: new Date().toISOString(),
  privacy_consent_version: "2026-10-01",
  email_optin: "0",
});

beforeAll(async () => {
  await n8nWindow.open();
  for (const prefix of ["I-11 ", "I-12 "]) restores.push((await activateForTest(prefix)).restore);
  // 親を有効にした後で Mautic の Webhook を公開に戻す（逆の順だと、公開してすぐの送信が 404 になって、また止められうる）
  if (MAUTIC_REACHES_N8N) restores.push(await publishMauticHook());
});

afterAll(async () => {
  try {
    for (const restore of restores.reverse()) await restore();
    await new Promise((r) => setTimeout(r, 3_000));
  } finally {
    try {
      await n8nWindow.close();
    } finally {
      await cleanup.runAll();
    }
  }
});

describe("通し: I-08 → I-11 → I-21（無料相談フォーム → Mautic → n8n → MailHog）", () => {
  describe("正常系", () => {
    const I08_NAME = "フォームを送ると、Mautic が署名した Webhook を n8n に送り、I-11 が冪等キーを記録し、I-21 が demo-requested を通知する";
    // 再現: 開発の Mautic の config/local.php で webhook_allowed_private_addresses が空のまま、無料相談フォームを送る。
    // 実際: Mautic が Webhook「n8n I-11」（http://127.0.0.1:5678/webhook/mautic-event）を送らない（webhook_logs の status_code が N/A、
    //       note が "Access to private addresses is not allowed."）。I-11 には何も届かず、通知も冪等キーも無い。
    // 期待: Mautic の setup が 127.0.0.1（開発の n8n）を webhook_allowed_private_addresses に入れ、Webhook が届いて 200・demo-requested の通知になる
    if (!MAUTIC_REACHES_N8N) it.todo(`${I08_NAME}（Mautic が私設アドレスへの Webhook を拒む設定のため未確認）`);
    else it(I08_NAME, async () => {
      const email = itEmail("consult");
      const company = itName("company");
      const formId = requireValue("MAUTIC_FORM_ID_CONSULT");
      const res = await submitMauticForm(formId, "consult", consultForm(email, company));
      // 送信記録（form_submissions と結果の表）は Mautic の API では消せないので、開発の MySQL で自分の email の行だけを消す
      cleanup.add(`Mautic のフォームの送信記録（${email}）`, () => deleteFormSubmissions(formId, "consult", email));
      expect(res.status).toBe(200);
      expect(res.json?.success).toBe(1);

      const [contact] = await waitForList(() => findContactsByEmail(email), "フォームから作られたコンタクト");
      const contactId = contact!.id;
      cleanup.add(`Mautic のコンタクト ${contactId}`, () => deleteContact(contactId));

      // 署名の検証を通った（401 なら行は増えない）ことを、冪等キーの行で確かめる
      const recorded = await waitFor(async () => {
        const list = await rows("dedup_mautic", [{ columnName: "contactId", condition: "eq", value: contactId }]);
        return list.some((r) => r.eventType === "mautic.form_on_submit") && list;
      }, { what: "form_on_submit の冪等キー", timeoutMs: 40_000 });
      expect(recorded.every((r) => String(r.dedupKey).startsWith(`${contactId}|`))).toBe(true);

      const [mail] = await waitForList(() => alerts(`(contact ${contactId})`), "I-21 の通知");
      expect(mail!.Content.Headers.Subject?.[0]).toBe(`[comegin] lead: demo-requested (contact ${contactId})`);
      const body = decodeBody(mail!);
      expect(body).toContain(`会社名: ${company}`);
      expect(body).not.toContain(email);
      // フォームの 1 回の送信からは、コンタクトの作成などの通知しない種別も届くが、通知は 1 通だけ
      await expectNever(async () => (await alerts(`(contact ${contactId})`)).length > 1, { durationMs: 5_000, what: "2 通目の通知" });
    });
  });

  describe("異常系", () => {
    it("入力: 必須の項目（email）が無いフォームは Mautic が受け付けず（success 0）、コンタクトは作られない", async () => {
      const company = itName("no-email");
      const fields = consultForm("", company);
      const res = await submitMauticForm(requireValue("MAUTIC_FORM_ID_CONSULT"), "consult", fields);
      expect(res.status).toBe(200);
      expect(res.json?.success).toBe(0);
      expect(Object.keys(res.json?.validationErrors ?? {})).toContain("email");
      const found = await mauticApi<{ total?: string | number }>(`/contacts?search=${encodeURIComponent(`company:${company}`)}&limit=5`);
      expect(Number(found.json?.total ?? 0)).toBe(0);
    });

    it("空入力: 項目の無いフォーム送信は、必須の項目がすべて検証エラーになる", async () => {
      const res = await submitMauticForm(requireValue("MAUTIC_FORM_ID_CONSULT"), "consult", {});
      expect(res.json?.success).toBe(0);
      expect(Object.keys(res.json?.validationErrors ?? {})).toEqual(expect.arrayContaining(["company", "lastname", "firstname", "email", "message"]));
    });

    it("入力: 存在しないフォーム ID には送れない（success 0）", async () => {
      const res = await submitMauticForm("999999", "consult", consultForm(itEmail("no-form"), itName("no-form")));
      expect(res.json?.success).toBe(0);
      expect(res.json?.errorMessage).toBeTruthy();
      expect(await findContactsByEmail(itEmail("no-form"))).toEqual([]);
    });
  });
});

describe("通し: I-07 → I-12 → I-19・I-21（チャットウィジェット → Chatwoot → n8n）", () => {
  const startConversation = async (email: string) => {
    const started = await startWidgetConversation({ email, name: itName("visitor"), content: itName("hello") });
    if (started.displayId) cleanup.add(`Chatwoot の会話 ${started.displayId}`, () => deleteChatwootConversation(started.displayId));
    if (started.contactId) cleanup.add(`Chatwoot のコンタクト ${started.contactId}`, () => deleteChatwootContact(started.contactId));
    return started;
  };

  describe("正常系", () => {
    const I07_NAME = "email 付きで会話を始めると、Chatwoot が署名した Webhook を送り、I-12 が会話とメッセージを記録し、I-21 が通知し、I-19 が Mautic のコンタクトと対応付ける";
    // 再現: 開発の Chatwoot（backend/chatwoot-system）に SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true が無いまま、ウィジェットで会話を始める。
    // 実際: Sidekiq の WebhookJob が "Invalid webhook URL http://host.docker.internal:5678/webhook/chatwoot-event : Hostname
    //       'host.docker.internal' has no public ip addresses" で送らずに終わる（再送もしない）。I-12・I-19・I-21 は動かない。
    // 期待: 開発の Chatwoot の環境変数で私設アドレスへの送信を許し、会話とメッセージの冪等キー・通知・contact_link（matched）ができる
    if (!CHATWOOT_REACHES_N8N) it.todo(`${I07_NAME}（Chatwoot が私設アドレスへの Webhook を拒む設定のため未確認）`);
    else it(I07_NAME, async () => {
      const email = itEmail("widget");
      const created = await mauticApi<{ contact: { id: number } }>("/contacts/new", { method: "POST", body: { email, firstname: itName("widget") } });
      const mauticContactId = Number(created.json?.contact.id);
      cleanup.add(`Mautic のコンタクト ${mauticContactId}`, () => deleteContact(mauticContactId));

      const { status, displayId, contactId } = await startConversation(email);
      expect(status).toBe(200);
      expect(displayId).toBeGreaterThan(0);

      // conversation_created と、最初のメッセージの message_created の 2 つ
      const recorded = await waitForList(() => rows("dedup_chatwoot", [{ columnName: "displayId", condition: "eq", value: displayId }]), "会話とメッセージの冪等キー", 2);
      expect(recorded.map((r) => r.messageId)).toContain("conversation_created");

      const [mail] = await waitForList(() => alerts(`(conversation ${displayId})`), "I-21 の通知");
      expect(mail!.Content.Headers.Subject?.[0]).toBe(`[comegin] lead: conversation-opened (conversation ${displayId})`);
      expect(decodeBody(mail!)).not.toContain(email);

      const [link] = await waitForList(() => rows("contact_link", [{ columnName: "chatwootContactId", condition: "eq", value: contactId }]), "contact_link の行");
      expect(link).toMatchObject({ chatwootContactId: contactId, displayId, status: "matched", mauticContactId, matchCount: 1 });
    });
  });

  describe("異常系", () => {
    it("入力: 登録されていない website_token ではウィジェットの入口（config）が 404 を返し、会話を始められない", async () => {
      // 共有の chatwootWidgetSession は登録済みの website_token しか使わないので、ウィジェットの入口（config）に直接送る
      const res = await http(`${DEV.chatwoot}/api/v1/widget/config?website_token=${encodeURIComponent(itName("token"))}`, { method: "POST" });
      expect(res.status).toBe(404);
    });

    const DOWN_NAME = "サーバ: n8n の I-12 が公開されていない間に始まった会話は、Webhook が 404 になり、記録も通知もされない";
    // 再現と期待は上の正常系と同じ（Chatwoot が Webhook を送らない間は、404 の経路を通らないので確かめられない）
    if (!CHATWOOT_REACHES_N8N) it.todo(`${DOWN_NAME}（Chatwoot が私設アドレスへの Webhook を拒む設定のため未確認）`);
    else it(DOWN_NAME, async () => {
      const i12 = await findWorkflow("I-12 ");
      await setActive(i12.id, false);
      try {
        const { status, displayId } = await startConversation(itEmail("while-down"));
        expect(status).toBe(200);
        await expectNever(
          async () => (await rows("dedup_chatwoot", [{ columnName: "displayId", condition: "eq", value: displayId }])).length > 0 || (await alerts(`(conversation ${displayId})`)).length > 0,
          { durationMs: 10_000, what: "受け口が無い間の会話の記録か通知" },
        );
      } finally {
        await setActive(i12.id, true);
      }
    });
  });
});
