// provision/provision.mjs（Data Table・資格情報・Webhook・ワークフローの取り込み）の単体テスト。
// global fetch を偽の上流（tests/helpers/fake-upstream.mjs）に差し替える。実際の n8n・Mautic・Chatwoot には繋がない。
// ワークフローの JSON はリポジトリの workflows/ をそのまま読む（provision が読むのと同じもの）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConf, provision } from "../../provision/provision.mjs";
import { CHATWOOT, MAUTIC, N8N, SECRETS, captureIo, createFakeUpstream } from "../helpers/fake-upstream.mjs";

const BASE_VALUES = {
  N8N_API_KEY: SECRETS.N8N_API_KEY,
  MAUTIC_CLIENT_ID: SECRETS.MAUTIC_CLIENT_ID,
  MAUTIC_CLIENT_SECRET: SECRETS.MAUTIC_CLIENT_SECRET,
  CHATWOOT_ACCOUNT_ID: 1,
  CHATWOOT_API_ACCESS_TOKEN: SECRETS.CHATWOOT_API_ACCESS_TOKEN,
};
const PROD_VALUES = {
  ...BASE_VALUES,
  // 本番の既定の接続先（https://mkt.comegin.com など）を、偽の上流のオリジンに向ける
  N8N_BASE_URL: N8N,
  MAUTIC_API_URL: MAUTIC,
  CHATWOOT_API_URL: CHATWOOT,
  AWS_ACCESS_KEY_ID: "AKIA-TEST-NOT-REAL",
  AWS_SECRET_ACCESS_KEY: SECRETS.AWS_SECRET_ACCESS_KEY,
  SNS_TOPIC_ARN_LEAD: "arn:aws:sns:ap-northeast-1:000000000000:comegin-lead-alert",
  SNS_TOPIC_ARN_OPS: "arn:aws:sns:ap-northeast-1:000000000000:comegin-ops-alert",
};

const SCHEDULED_NAMES = ["週次 問い合わせの棚卸し", "n8n スケジュール実行のハートビート", "運用監視（OpenSEO・サンドボックスの証明書）"];

let up;
let out;

beforeEach(() => {
  up = createFakeUpstream();
  vi.stubGlobal("fetch", up.fetch);
  out = captureIo();
});

const run = (target = "dev", { values = {}, ...opts } = {}) =>
  provision({ target, conf: buildConf(target, { ...(target === "dev" ? BASE_VALUES : PROD_VALUES), ...values }), io: out.io, ...opts });

const wfByName = (name) => up.state.workflows.find((w) => w.name.startsWith(name));
const credByName = (name) => up.state.credentials.find((c) => c.name === name);
const allSecretsHidden = (text) => {
  for (const [k, v] of Object.entries(SECRETS)) expect(text, k).not.toContain(v);
};

describe("buildConf", () => {
  describe("正常系", () => {
    it("dev の既定値（n8n から見た Mautic・Chatwoot は host.docker.internal）に、渡した値を足す", () => {
      const conf = buildConf("dev", BASE_VALUES);
      expect(conf).toMatchObject({
        N8N_BASE_URL: "http://127.0.0.1:5678",
        MAUTIC_URL_FROM_N8N: "http://host.docker.internal:8000",
        CHATWOOT_URL_FROM_N8N: "http://host.docker.internal:3100",
        SMTP_HOST: "host.docker.internal",
        CHATWOOT_ACCOUNT_ID: "1",
      });
    });

    it("prod の既定値では、n8n から見た Chatwoot も公開の URL（https://chat.comegin.com）", () => {
      expect(buildConf("prod", PROD_VALUES).CHATWOOT_URL_FROM_N8N).toBe("https://chat.comegin.com");
    });

    it("_URL・_TARGET・_FROM_N8N で終わる値の末尾の / を除く", () => {
      const conf = buildConf("dev", { ...BASE_VALUES, CHATWOOT_URL_FROM_N8N: "http://x:3100//", MAUTIC_API_URL: "http://m/", CHATWOOT_WEBHOOK_TARGET: "http://t/hook/" });
      expect(conf).toMatchObject({ CHATWOOT_URL_FROM_N8N: "http://x:3100", MAUTIC_API_URL: "http://m", CHATWOOT_WEBHOOK_TARGET: "http://t/hook" });
    });

    it("空入力: 空文字・null・undefined の値は既定値を上書きしない", () => {
      const conf = buildConf("dev", { ...BASE_VALUES, CHATWOOT_URL_FROM_N8N: "", SMTP_HOST: null, SMTP_PORT: undefined });
      expect(conf).toMatchObject({ CHATWOOT_URL_FROM_N8N: "http://host.docker.internal:3100", SMTP_HOST: "host.docker.internal", SMTP_PORT: "1025" });
    });
  });

  describe("異常系", () => {
    it("入力: target が dev・prod 以外なら例外にする", () => {
      expect(() => buildConf("staging", BASE_VALUES)).toThrow("target は dev か prod: staging");
    });

    it("空入力: 値が 1 つも無ければ、足りない必須の項目の名前を並べて例外にする", () => {
      expect(() => buildConf("dev", {})).toThrow(/設定に足りない項目がある（値は表示しない）: N8N_API_KEY, MAUTIC_CLIENT_ID, MAUTIC_CLIENT_SECRET, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_ACCESS_TOKEN$/);
    });

    it("入力: prod で AWS・SNS の値が無ければ、その名前を並べて例外にし、渡した秘密値は出さない", () => {
      const err = (() => {
        try {
          buildConf("prod", BASE_VALUES);
        } catch (e) {
          return e;
        }
      })();
      expect(err.message).toContain("AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SNS_TOPIC_ARN_LEAD, SNS_TOPIC_ARN_OPS");
      allSecretsHidden(err.message);
    });
  });
});

describe("provision（開発環境）", () => {
  describe("正常系", () => {
    it("Data Table を 5 つ作り、ops_settings に接続先と、定期実行のスイッチ（既定は false）を入れる", async () => {
      await run();
      expect(up.state.dataTables.map((t) => t.name)).toEqual(["dedup_mautic", "dedup_chatwoot", "ops_settings", "monitor_state", "contact_link"]);
      expect(Object.fromEntries(up.opsRows().map((r) => [r.key, r.value]))).toEqual({
        notifyBackend: "mailhog",
        mauticBaseUrl: "http://host.docker.internal:8000",
        chatwootBaseUrl: "http://host.docker.internal:3100",
        chatwootAccountId: "1",
        heartbeatEnabled: "false",
        heartbeatNamespace: "ComeGin/OnpremN8n",
        opsMonitorEnabled: "false",
        inventoryEnabled: "false",
      });
    });

    it("8 本を子 → 親の順に取り込み、子（I-21・I-19）だけを公開する。定期実行の 3 本は公開しない", async () => {
      const { workflows } = await run();
      expect(workflows.map((w) => w.name.split(" ")[0])).toEqual(["I-21", "I-19", "I-11", "I-12", "I-18", "週次", "n8n", "運用監視（OpenSEO・サンドボックスの証明書）"]);
      expect(workflows.filter((w) => w.published).map((w) => w.name.slice(0, 4))).toEqual(["I-21", "I-19"]);
      for (const name of SCHEDULED_NAMES) expect(wfByName(name).published, name).toBe(false);
      expect(workflows.every((w) => w.action === "作成")).toBe(true);
    });

    it("publish: true でも、定期実行の 3 本は公開しない（親の I-11・I-12 は公開する）", async () => {
      const { workflows } = await run("dev", { publish: true });
      expect(workflows.filter((w) => w.published).map((w) => w.name.slice(0, 4))).toEqual(["I-21", "I-19", "I-11", "I-12"]);
      for (const name of SCHEDULED_NAMES) expect(wfByName(name).published, name).toBe(false);
    });

    it("サブワークフローの呼び出し先を、取り込み先の I-21 の ID に付け替える（定期実行の呼び出しも）", async () => {
      await run();
      const i21 = wfByName("I-21");
      for (const name of ["I-11", "I-12", ...SCHEDULED_NAMES.filter((n) => !n.startsWith("n8n"))]) {
        const calls = wfByName(name).nodes.filter((n) => n.type === "n8n-nodes-base.executeWorkflow" && n.parameters.workflowId.cachedResultName === i21.name);
        expect(calls.length, name).toBeGreaterThan(0);
        for (const c of calls) expect(c.parameters.workflowId, `${name}/${c.name}`).toEqual({ __rl: true, mode: "id", value: i21.id, cachedResultName: i21.name });
      }
    });

    it("ノードの資格情報に、取り込み先の資格情報の ID を付ける（棚卸しの Chatwoot API も）", async () => {
      await run();
      const http = wfByName("週次").nodes.find((n) => n.type === "n8n-nodes-base.httpRequest");
      expect(http.credentials.httpHeaderAuth).toEqual({ id: credByName("Chatwoot API（api_access_token）").id, name: "Chatwoot API（api_access_token）" });
    });

    it("棚卸し用の Chatwoot API の資格情報は、CHATWOOT_N8N_API_TOKEN があればそれを入れる", async () => {
      await run("dev", { values: { CHATWOOT_N8N_API_TOKEN: SECRETS.CHATWOOT_N8N_API_TOKEN } });
      expect(credByName("Chatwoot API（api_access_token）")).toMatchObject({ type: "httpHeaderAuth", data: { name: "api_access_token", value: SECRETS.CHATWOOT_N8N_API_TOKEN } });
      expect(out.warns).toEqual([]);
    });

    it("空入力: CHATWOOT_N8N_API_TOKEN が無ければ管理者のトークンで代用し、開発では警告しない", async () => {
      await run();
      expect(credByName("Chatwoot API（api_access_token）").data.value).toBe(SECRETS.CHATWOOT_API_ACCESS_TOKEN);
      expect(out.warns).toEqual([]);
    });

    it("Webhook のシークレットを n8n の署名鍵の資格情報に入れ、AWS は開発のダミーを置く", async () => {
      await run();
      expect(credByName("Mautic Webhook 署名鍵（Crypto）").data).toEqual({ hmacSecret: SECRETS.MAUTIC_HOOK_SECRET });
      expect(credByName("Chatwoot Webhook 署名鍵（Crypto）").data).toEqual({ hmacSecret: SECRETS.CHATWOOT_HOOK_SECRET });
      expect(credByName("AWS SNS 発行（アクセスキー）").data.accessKeyId).toBe("DEV-PLACEHOLDER-NOT-USED");
    });

    it("2 回目の実行は作り直さずに更新し、人が true にしたスイッチを false に戻さない", async () => {
      await run();
      const opsId = up.state.dataTables.find((t) => t.name === "ops_settings").id;
      up.state.rows[opsId].find((r) => r.key === "inventoryEnabled").value = "true";
      up.state.requests.length = 0;

      const { workflows } = await run();
      expect(workflows.every((w) => w.action === "更新")).toBe(true);
      expect(up.state.workflows).toHaveLength(8);
      expect(up.state.dataTables).toHaveLength(5);
      expect(up.opsRows().find((r) => r.key === "inventoryEnabled").value).toBe("true");
      // スイッチの行の追加（POST /rows）はしない
      expect(up.writes().filter((w) => /\/rows$/.test(w))).toEqual([]);
      expect(out.logs.join("\n")).toContain("スイッチ は既にある（変えない）");
    });

    it("空入力: スイッチの行が一部しか無ければ、無いものだけを足す", async () => {
      await run();
      const opsId = up.state.dataTables.find((t) => t.name === "ops_settings").id;
      up.state.rows[opsId] = up.state.rows[opsId].filter((r) => r.key !== "opsMonitorEnabled" && r.key !== "heartbeatNamespace");
      up.state.requests.length = 0;
      await run();
      const added = up.state.requests.find((r) => r.method === "POST" && r.url.endsWith(`/data-tables/${opsId}/rows`));
      expect(added.body).toEqual({ data: [{ key: "heartbeatNamespace", value: "ComeGin/OnpremN8n" }, { key: "opsMonitorEnabled", value: "false" }], returnType: "count" });
    });

    it("n8n の一覧はカーソルでページを送り、全部を読む（250 件を超える n8n でも重複を作らない）", async () => {
      up = createFakeUpstream({ pageSize: 2 });
      vi.stubGlobal("fetch", up.fetch);
      await run();
      up.state.requests.length = 0;
      await run();
      expect(up.state.workflows).toHaveLength(8);
      expect(up.state.requests.some((r) => r.method === "GET" && r.url.includes("/workflows?limit=250&cursor="))).toBe(true);
    });

    it("既にある資格情報は、公開 API が 405 なら内部 API（オーナーの cookie）で値を入れ直す。cookie は 1 回だけ取る", async () => {
      await run();
      let sessions = 0;
      const restSession = async () => {
        sessions++;
        return "n8n-auth=cookie-value";
      };
      up.state.requests.length = 0;
      await run("dev", { restSession });
      expect(sessions).toBeGreaterThan(0);
      const restPatches = up.state.requests.filter((r) => r.method === "PATCH" && r.url.startsWith(`${N8N}/rest/credentials/`));
      // 開発の AWS のダミー（keepExisting）以外の 5 つを入れ直す
      expect(restPatches).toHaveLength(5);
      expect(restPatches.every((r) => r.headers.Cookie === "n8n-auth=cookie-value")).toBe(true);
    });

    it("--check（checkOnly）は接続を確かめるだけで、何も書かない", async () => {
      expect(await run("dev", { checkOnly: true })).toEqual({ workflows: [] });
      expect(up.writes()).toEqual([]);
      expect(out.logs.join("\n")).toContain("ワークフローの JSON: 8 本ある");
    });

    it("出力（log・warn）に秘密値を出さない", async () => {
      await run("dev", { values: { CHATWOOT_N8N_API_TOKEN: SECRETS.CHATWOOT_N8N_API_TOKEN } });
      allSecretsHidden(out.text());
    });

    it("どの要求にもタイムアウトの signal を付ける（応答の無い上流で止まり続けない）", async () => {
      await run();
      expect(up.state.requests.length).toBeGreaterThan(0);
      for (const r of up.state.requests) expect(r.signal, r.url).toBeInstanceOf(AbortSignal);
    });
  });

  describe("異常系", () => {
    it("入力: 資格情報の更新が 405 で、cookie を取る手段（restSession）が無ければ、警告して既にある値のまま進む", async () => {
      await run();
      out = captureIo();
      await run();
      expect(out.warns.length).toBe(5);
      expect(out.warns[0]).toContain("値を入れ直せない");
      allSecretsHidden(out.text());
    });

    it("サーバ: n8n が API キーを拒む（401）なら、どの操作かと HTTP の状態を示して止まり、API キーは出さない", async () => {
      const err = await run("dev", { values: { N8N_API_KEY: "wrong-api-key-000" } }).catch((e) => e);
      expect(err.message).toBe("n8n API キーの確認: HTTP 401（unauthorized）");
      expect(err.status).toBe(401);
      expect(err.message).not.toContain("wrong-api-key-000");
      expect(up.writes()).toEqual([]);
    });

    it("サーバ: 接続できない（fetch の reject）なら status 0 で、オリジンだけを示す（パス・クエリを出さない）", async () => {
      up.state.overrides.push({ match: (_m, u) => u.origin === N8N, respond: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })) });
      const err = await run().catch((e) => e);
      expect(err.status).toBe(0);
      expect(err.message).toBe("n8n API キーの確認: http://127.0.0.1:5678 に接続できない（ECONNREFUSED）");
    });

    it("サーバ: タイムアウト（AbortSignal.timeout の TimeoutError）なら「タイムアウト」と示す", async () => {
      up.state.overrides.push({ match: (_m, u) => u.origin === MAUTIC, respond: () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")) });
      const err = await run().catch((e) => e);
      expect(err.message).toBe("Mautic のトークンの取得: http://127.0.0.1:8000 に接続できない（タイムアウト）");
    });

    it("サーバ: 失敗の応答の本文はエラーの説明（message）だけを出し、ほかの項目（シークレットなど）は出さない", async () => {
      up.state.overrides.push({ match: (m, u) => m === "POST" && u.pathname === "/api/v1/data-tables", respond: () => new Response(JSON.stringify({ message: "boom", secret: "leaked-secret-zzz" }), { status: 500 }) });
      const err = await run().catch((e) => e);
      expect(err.message).toBe("n8n Data Table dedup_mautic の作成: HTTP 500（boom）");
      expect(err.message).not.toContain("leaked-secret-zzz");
    });

    it("サーバ: JSON でない失敗の応答（HTML の 502）は、HTTP の状態だけを示す", async () => {
      up.state.overrides.push({ match: (_m, u) => u.origin === CHATWOOT, respond: () => new Response("<html>502 Bad Gateway</html>", { status: 502 }) });
      const err = await run().catch((e) => e);
      expect(err.message).toBe("Chatwoot の Webhook の一覧: HTTP 502");
    });

    it("サーバ: n8n の権限不足（403。API キーのスコープ不足）で書き込みが拒まれたら止まる", async () => {
      up.state.overrides.push({ match: (m, u) => m === "POST" && u.pathname === "/api/v1/tags", respond: () => new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }) });
      const err = await run().catch((e) => e);
      expect(err.message).toMatch(/^n8n タグ .+ の作成: HTTP 403（Forbidden）$/);
      expect(up.state.workflows).toEqual([]);
    });

    it("サーバ: Mautic の資格情報が違う（400）なら止まり、クライアントのシークレットは出さない", async () => {
      const err = await run("dev", { values: { MAUTIC_CLIENT_SECRET: "wrong-client-secret" } }).catch((e) => e);
      expect(err.message).toBe("Mautic のトークンの取得: HTTP 400（invalid_client）");
      expect(err.message).not.toContain("wrong-client-secret");
    });

    it("サーバ: Mautic がトークンを返さない（想定外の形の 200）なら止まる", async () => {
      up.state.overrides.push({ match: (_m, u) => u.pathname === "/oauth/v2/token", respond: () => new Response(JSON.stringify({ token_type: "bearer" }), { status: 200 }) });
      await expect(run()).rejects.toThrow("Mautic のトークンが返らなかった（API が有効か、資格情報が正しいかを確かめる）");
    });

    it("サーバ: Chatwoot のトークンに管理者の権限が無い（401）なら、管理者のトークンが要ることを示して止まる", async () => {
      const err = await run("dev", { values: { CHATWOOT_API_ACCESS_TOKEN: "agent-token-000" } }).catch((e) => e);
      expect(err.message).toContain("Chatwoot の Webhook の一覧: HTTP 401");
      expect(err.message).not.toContain("agent-token-000");
    });

    it("サーバ: Chatwoot の Webhook の作成で 403 なら、管理者のトークンが要ることを示して止まる", async () => {
      // check の一覧は通し、ensureChatwootWebhook の一覧で 403 にする
      let calls = 0;
      up.state.overrides.push({ match: (m, u) => m === "GET" && u.origin === CHATWOOT && ++calls > 1, respond: () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) });
      await expect(run()).rejects.toThrow("Chatwoot の Webhook の一覧: HTTP 403（Forbidden）。Webhook の操作には、Chatwoot の管理者（Administrator）のアクセストークンが要る");
    });

    it("サーバ: Mautic・Chatwoot の Webhook の応答にシークレットが無ければ、資格情報を作らずに止まる", async () => {
      up.state.mauticReturnsSecret = false;
      await expect(run()).rejects.toThrow("Mautic の Webhook のシークレットを取得できなかった");
      up = createFakeUpstream();
      up.state.chatwootReturnsSecret = false;
      vi.stubGlobal("fetch", up.fetch);
      await expect(run()).rejects.toThrow("Chatwoot の Webhook のシークレットを取得できなかった（Chatwoot が 4.12 より古い可能性がある）");
      expect(up.state.credentials).toEqual([]);
    });

    it("サーバ: 資格情報の更新が 405 以外（500）で失敗したら、内部 API に切り替えずに止まる", async () => {
      await run();
      up.state.credentialPatch = 500;
      await expect(run("dev", { restSession: async () => "n8n-auth=x" })).rejects.toThrow(/^n8n 資格情報 .+ の更新: HTTP 500/);
      expect(up.state.requests.some((r) => r.url.includes("/rest/credentials/"))).toBe(false);
    });

    it("サーバ: 既にある Webhook のイベントが足りなければ直し、同じなら変えない", async () => {
      up.state.mauticHooks.push({ id: 7, webhookUrl: "http://127.0.0.1:5678/webhook/mautic-event", triggers: ["mautic.lead_post_save_new"], isPublished: true, secret: SECRETS.MAUTIC_HOOK_SECRET });
      up.state.chatwootHooks.push({ id: 8, url: "http://host.docker.internal:5678/webhook/chatwoot-event", subscriptions: ["conversation_created", "message_created"], secret: SECRETS.CHATWOOT_HOOK_SECRET });
      await run();
      expect(up.writes()).toContain("PATCH /api/hooks/7/edit");
      expect(up.writes().some((w) => w.includes("/webhooks"))).toBe(false);
      expect(up.state.mauticHooks).toHaveLength(1);
    });
  });
});

describe("provision（本番）", () => {
  describe("正常系", () => {
    it("運用監視（ops-monitor）は取り込まず、7 本だけを取り込む", async () => {
      const { workflows } = await run("prod");
      expect(workflows).toHaveLength(7);
      expect(workflows.some((w) => w.name.startsWith("運用監視"))).toBe(false);
      expect(up.state.workflows.some((w) => w.name.startsWith("運用監視"))).toBe(false);
    });

    it("ops_settings は SNS に送る設定で、n8n から見た Chatwoot は公開の URL", async () => {
      await run("prod");
      expect(Object.fromEntries(up.opsRows().map((r) => [r.key, r.value]))).toMatchObject({
        notifyBackend: "sns",
        snsTopicArnLead: PROD_VALUES.SNS_TOPIC_ARN_LEAD,
        snsTopicArnOps: PROD_VALUES.SNS_TOPIC_ARN_OPS,
        chatwootBaseUrl: "https://chat.comegin.com",
        chatwootAccountId: "1",
      });
    });

    it("--check（checkOnly）でも、本番で取り込む 7 本の JSON だけを数える", async () => {
      await run("prod", { checkOnly: true });
      expect(out.logs.join("\n")).toContain("ワークフローの JSON: 7 本ある");
    });
  });

  describe("異常系", () => {
    it("空入力: CHATWOOT_N8N_API_TOKEN が無ければ、管理者のトークンを入れることを警告する（値は出さない）", async () => {
      await run("prod");
      expect(out.warns).toEqual([expect.stringContaining("CHATWOOT_N8N_API_TOKEN が空")]);
      allSecretsHidden(out.text());
    });

    it("入力: 本番で publish を付けると、R1 の判断であることを警告する", async () => {
      await run("prod", { publish: true, values: { CHATWOOT_N8N_API_TOKEN: SECRETS.CHATWOOT_N8N_API_TOKEN } });
      expect(out.warns).toEqual([expect.stringContaining("本番の親（I-11・I-12）を公開する")]);
      for (const name of SCHEDULED_NAMES.slice(0, 2)) expect(wfByName(name).published, name).toBe(false);
    });
  });
});
