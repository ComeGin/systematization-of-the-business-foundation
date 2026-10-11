import type { ChatwootClient } from "./chatwoot/client.js";
import { type BotEvent, InvalidEventError, parseEvent, type WelcomeEvent } from "./chatwoot/events.js";
import { verifySignature } from "./chatwoot/signature.js";
import type { Config } from "./config.js";
import { HEALTH_PATH, MAX_BODY_BYTES, SIGNATURE_TOLERANCE_SECONDS, WEBHOOK_PATH } from "./constants.js";
import { decide } from "./dialog/decide.js";
import { execute, executeWelcome } from "./dialog/execute.js";
import { welcomeItems, welcomeReply } from "./dialog/welcome.js";
import type { FaqSource } from "./faq/store.js";

/** 入口に依存しない要求（ヘッダー名は小文字）。開発は server.ts、本番は lambda.ts が作る */
export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export type Handle = (req: HttpRequest) => Promise<HttpResponse>;

export interface HandlerDeps {
  config: Config;
  faq: FaqSource;
  client: ChatwootClient;
  nowSeconds?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

const json = (status: number, body: unknown): HttpResponse => ({ status, body: JSON.stringify(body) });

/**
 * Webhook を受けて判定し、Chatwoot に反映する（仕様 6〜8 節）。
 * 失敗（faq.json が無い・Chatwoot の API の失敗）は例外で投げる。入口が 502 にし、メッセージのイベントなら Chatwoot は会話を open にする
 * （ウィジェットを開いたイベント〈webwidget_triggered〉では Chatwoot は何もせず、一覧が出ないだけ）。
 * ログは 1 件 1 行。メッセージの本文・氏名・メールアドレス・トークン・source_id は出さない
 */
export function createHandler(deps: HandlerDeps): Handle {
  const { config, faq, client } = deps;
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.error(JSON.stringify(entry)));
  const thresholds = { high: config.FAQ_MATCH_HIGH, low: config.FAQ_MATCH_LOW, margin: config.FAQ_MATCH_MARGIN };

  /**
   * ウィジェットを開いたとき（2026-10-12 の仕様 3 節）。進行中の会話があれば何もしない（開くたびに一覧を出さない）。
   * 会話が無いか直前の会話が resolved なら、トップページの FAQ の一覧を新しい会話に出す。ログに source_id を出さない
   */
  async function handleWelcome(event: WelcomeEvent, startedAt: number): Promise<HttpResponse> {
    const done = (decision: string, extra: Record<string, unknown> = {}): HttpResponse => {
      // contact_inbox（ContactInbox の内部の id）で、同じ訪問者が素早く 2 回開いたことをログだけで追える
      log({ t: new Date().toISOString(), level: "info", event: event.kind, contact_inbox: event.contactInboxId, decision, ...extra, ms: Date.now() - startedAt });
      return json(200, { result: decision });
    };
    if (event.currentStatus !== null && event.currentStatus !== "resolved") return done("skip-active");
    const items = welcomeItems(await faq.current());
    if (items.length === 0) return done("skip-empty");
    const result = await executeWelcome(client, event, welcomeReply(items));
    return done(result.outcome === "sent" ? "welcome" : "skip-not-pending", { conversation: result.conversationId, faq: items.map((item) => item.id) });
  }

  return async (req) => {
    const startedAt = Date.now();
    if (req.path === HEALTH_PATH) return req.method === "GET" ? json(200, { ok: true }) : json(405, { error: "method_not_allowed" });
    if (req.path !== WEBHOOK_PATH) return json(404, { error: "not_found" });
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (req.body.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

    const signature = verifySignature({
      secret: config.CHATWOOT_BOT_SECRET,
      timestamp: req.headers["x-chatwoot-timestamp"],
      signature: req.headers["x-chatwoot-signature"],
      rawBody: req.body,
      nowSeconds: nowSeconds(),
      toleranceSeconds: SIGNATURE_TOLERANCE_SECONDS,
    });
    if (!signature.ok) {
      log({ t: new Date().toISOString(), level: "warn", result: "unauthorized", reason: signature.reason });
      return json(401, { error: "unauthorized" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return json(400, { error: "invalid_json" });
    }
    let event: BotEvent;
    try {
      event = parseEvent(payload);
    } catch (error) {
      if (error instanceof InvalidEventError) {
        // Chatwoot の更新で本文の形が変わると黙って止まるため、違う項目の名前だけを出す（InvalidEventError のメッセージは値を含まない）
        log({ t: new Date().toISOString(), level: "warn", result: "invalid_event", reason: error.message });
        return json(400, { error: "invalid_event" });
      }
      throw error;
    }
    if (event.kind === "ignore") return json(200, { result: "ignored" });
    if (event.accountId !== config.CHATWOOT_ACCOUNT_ID) {
      log({ t: new Date().toISOString(), level: "warn", result: "ignored", reason: "account" });
      return json(200, { result: "ignored" });
    }
    if (event.kind === "welcome") return handleWelcome(event, startedAt);

    const snapshot = await faq.current();
    const action = decide(event, snapshot, thresholds);
    const result = await execute(client, event, action);
    log({
      t: new Date().toISOString(),
      level: "info",
      conversation: event.conversationId,
      event: event.kind,
      decision: action.decision,
      top: action.topScore,
      faq: action.faqIds,
      outcome: result.outcome,
      sent: result.sent,
      ms: Date.now() - startedAt,
    });
    return json(200, { result: result.outcome });
  };
}
