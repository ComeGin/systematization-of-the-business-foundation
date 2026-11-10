// 本番の Mautic の読み取り（改善ループの campaign の項目。中身の表示と、公開＝送信の開始の確認）。
// - 認証は OAuth2 client_credentials（`<baseUrl>/oauth/v2/token`）。参照専用ロールの API 認証情報を control-plane 用に発行して使う（spec 5.8）。
// - トークンはプロセス内でキャッシュし、期限の 60 秒前に取り直す。API が 401 を返したら 1 回だけ取り直して再試行する
//   （backend/mautic-mcp の mautic-client.ts と同じ振る舞い。再試行は http.ts の refreshAuth と AUTH_FAILED_RETRIES.mautic）。
// - 個々のコンタクトは読まない。セグメントの件数は統計の表（lead_lists_leads）の total だけを使う。
// - 認証情報・トークン・応答の本文はログにも結果にも出さない。
import type { ControlPlaneConfig } from "../config.js";
import { TIMEOUT_SEC } from "../constants/timeouts.js";
import { redactPii } from "../pii.js";
import { IntegrationError, fetchJson, requireSuccess } from "./http.js";

type MauticConfig = NonNullable<ControlPlaneConfig["mautic"]>;

/** トークンの期限がこの秒数未満になったら取り直す（mautic-mcp の TOKEN_REFRESH_MARGIN_SEC と同じ） */
const TOKEN_REFRESH_MARGIN_SEC = 60;
/** 画面に出すメール本文の上限（文字数） */
const BODY_TEXT_MAX = 5_000;

export interface MauticRecordState {
  isPublished: boolean;
  /** メールの送信数（送信が始まったら 1 以上） */
  sentCount?: number;
  name?: string;
  /** セグメントの件数（手で外したコンタクトを除く） */
  count?: number;
  /** メールの件名 */
  subject?: string;
  /** メールの本文（テキスト。HTML はタグを除いたもの。メールアドレス・電話番号の形は伏せ字） */
  bodyText?: string;
  /** キャンペーンの送信元のセグメントの ID */
  segmentIds?: number[];
  /** キャンペーンのメールを送るイベント（type が email.send）が送るメールの ID（イベントの順。読めないイベントは除く） */
  emailSendIds?: number[];
}

// 同じ認証情報なら実行をまたいでトークンを使い回す（取り直しは期限の前か 401 のとき）
const tokenCache = new Map<string, { value: string; expiresAt: number }>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** HTML からタグを除いたテキスト（style・script の中身は捨てる）。表示用の簡易なもの */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Mautic の一覧の値（配列か、id をキーにしたオブジェクト）の行 */
function rowsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
}

/** Mautic の一覧の値（配列か、id をキーにしたオブジェクト）から id を取り出す */
function idsOf(value: unknown): number[] {
  return rowsOf(value)
    .map((row) => (isRecord(row) ? num(row.id) : undefined))
    .filter((id): id is number => id !== undefined);
}

/**
 * キャンペーンの events のうち type が email.send のものが送るメールの ID。
 * 送るメールはイベントの properties.email（EmailSendType の欄）。無ければ channel が email のときの channelId（channelIdField が email）。
 * どちらも読めないイベントは -1 にする（「どのメールか分からない」を一致と取り違えない）
 */
function emailSendIdsOf(events: unknown): number[] {
  const ids: number[] = [];
  for (const event of rowsOf(events)) {
    if (!isRecord(event) || event.type !== "email.send") continue;
    const properties = isRecord(event.properties) ? event.properties : {};
    const id = num(properties.email) ?? (event.channel === "email" ? num(event.channelId) : undefined);
    ids.push(id ?? -1);
  }
  return ids;
}

export class MauticReader {
  constructor(
    private readonly config: MauticConfig,
    private readonly signal?: AbortSignal,
  ) {}

  private get cacheKey(): string {
    return `${this.config.baseUrl}\n${this.config.clientId}`;
  }

  private async token(force: boolean): Promise<string> {
    const cached = tokenCache.get(this.cacheKey);
    if (!force && cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_SEC * 1000 > Date.now()) return cached.value;
    const result = await fetchJson<{ access_token?: unknown; expires_in?: unknown }>({
      upstream: "mautic",
      url: `${this.config.baseUrl}/oauth/v2/token`,
      init: {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      },
      timeoutMs: TIMEOUT_SEC.mauticMcp * 1000,
      signal: this.signal,
    });
    requireSuccess(result, "Mautic: アクセストークンの取得");
    const accessToken = result.data?.access_token;
    const expiresIn = num(result.data?.expires_in);
    if (typeof accessToken !== "string" || accessToken === "" || expiresIn === undefined) {
      throw new IntegrationError("invalid_response", "Mautic: アクセストークンの応答の形が違う");
    }
    tokenCache.set(this.cacheKey, { value: accessToken, expiresAt: Date.now() + expiresIn * 1000 });
    return accessToken;
  }

  /** GET /api<path>。404 は null。401 はトークンを取り直して 1 回だけ再試行する */
  private async get(path: string): Promise<Record<string, unknown> | null> {
    // 再試行のときに fetchJson は同じ init を使うので、ヘッダーのオブジェクトを書き換えてトークンを差し替える
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token(false)}`, Accept: "application/json" };
    const result = await fetchJson<unknown>({
      upstream: "mautic",
      url: `${this.config.baseUrl}/api${path}`,
      init: { headers },
      timeoutMs: TIMEOUT_SEC.mauticMcp * 1000,
      signal: this.signal,
      refreshAuth: async () => {
        headers.Authorization = `Bearer ${await this.token(true)}`;
      },
    });
    if (result.status === 404) return null;
    requireSuccess(result, "Mautic: 読み取り");
    if (!isRecord(result.data)) throw new IntegrationError("invalid_response", "Mautic: 応答の形が違う");
    return result.data;
  }

  private async entity(path: string, key: string): Promise<Record<string, unknown> | null> {
    const data = await this.get(path);
    if (data === null) return null;
    const entity = data[key];
    if (!isRecord(entity)) throw new IntegrationError("invalid_response", `Mautic: 応答に ${key} が無い`);
    return entity;
  }

  /** メール 1 通（公開か・送信数・件名・本文のテキスト）。無ければ null */
  async getEmail(id: number): Promise<MauticRecordState | null> {
    const email = await this.entity(`/emails/${id}`, "email");
    if (!email) return null;
    const plain = typeof email.plainText === "string" ? email.plainText.trim() : "";
    const html = typeof email.customHtml === "string" ? email.customHtml : "";
    const text = plain || htmlToText(html);
    return {
      isPublished: email.isPublished === true,
      sentCount: num(email.sentCount),
      name: typeof email.name === "string" ? email.name : undefined,
      subject: typeof email.subject === "string" ? email.subject : undefined,
      bodyText: redactPii(text.length > BODY_TEXT_MAX ? `${text.slice(0, BODY_TEXT_MAX - 1)}…` : text).text,
    };
  }

  /** キャンペーン 1 つ（公開か・名前・送信元のセグメント・メールを送るイベントのメール）。無ければ null */
  async getCampaign(id: number): Promise<MauticRecordState | null> {
    const campaign = await this.entity(`/campaigns/${id}`, "campaign");
    if (!campaign) return null;
    return {
      isPublished: campaign.isPublished === true,
      name: typeof campaign.name === "string" ? campaign.name : undefined,
      segmentIds: idsOf(campaign.lists),
      emailSendIds: emailSendIdsOf(campaign.events),
    };
  }

  /**
   * セグメント 1 つ（公開か・名前・件数）。無ければ null。
   * 件数は統計の表 lead_lists_leads の total（手で外したものを除く）。表を読めない（権限など）ときは count を省く。
   */
  async getSegment(id: number): Promise<MauticRecordState | null> {
    const segment = await this.entity(`/segments/${id}`, "list");
    if (!segment) return null;
    let count: number | undefined;
    try {
      const query = [
        "where[0][col]=leadlist_id",
        "where[0][expr]=eq",
        `where[0][val]=${id}`,
        "where[1][col]=manually_removed",
        "where[1][expr]=eq",
        "where[1][val]=0",
        "start=0",
        "limit=1",
      ].join("&");
      const stats = await this.get(`/stats/lead_lists_leads?${query}`);
      // 存在しない表を指定すると、Mautic はエラーにせず表の一覧を返す（stats が無い）
      if (stats && "stats" in stats) count = num(stats.total);
    } catch (error) {
      if (!(error instanceof IntegrationError)) throw error;
    }
    return {
      isPublished: segment.isPublished === true,
      name: typeof segment.name === "string" ? segment.name : undefined,
      count,
    };
  }
}
