// アイキャッチ画像（builtin `article-cover`。spec 5.7）。
//
// 本番の Strapi の下書きの記事のうち cover が空のもの（公開版がまだ無い新しい記事と、公開版の cover も空の記事だけ。Ruling 33）を、
// 古い順に最大 CONTROL_COVER_MAX_PER_RUN 件まで、
// 「画像の生成（OpenAI）→ メディアライブラリへアップロード → 下書きの cover に結ぶ」で処理する。
//   - 公開版に cover があり、下書きの cover だけが空の記事は、画像を作らず、公開版の cover のファイル ID を下書きの cover に結ぶ
//     （費用なし。CONTROL_COVER_MAX_PER_RUN に数えない。結ばないと承認できず詰まるため）。
//   - プロンプトの雛形は承認済み main の ops/prompts/article-cover.md（作業ツリーのものは読まない。ADR-18）。
//   - 結べない（書き込みトークンに記事の更新の権限が無い。403）ときは、アップロードまでにして
//     targetIds に `cover-pending:<documentId>:<fileId>` を残す（cycle-collect が「表紙に結ぶ」の手順にする）。
//     生成の費用が毎日かからないよう、結び待ちの記事は kv に覚え、次回以降は生成せず結ぶことだけを再試行する。
//   - 書き込みトークン（CONTROL_STRAPI_WRITE_TOKEN）が無ければ、アップロードできないので生成の前に skipped にする（費用を出さない）。
//   - 記事ごとの失敗は続行する。全件失敗なら failure、一部なら partial。失敗した記事は cover が空のままなので、次の日に再試行される。
//     ただし生成・アップロードの失敗が記事ごとに連続 MAX_CONSECUTIVE_FAILURES 回に達したら対象から外す（毎日の枠と課金を取り続けないため。
//     戻すには kv の `article-cover:failures:<documentId>` を消す）。アップロードが auth_failed・permission_denied で失敗したら、その実行の以降の生成を打ち切る。
//   - 画像のバイト列・API キー・トークンはログにも結果にも出さない。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuiltinHandler, RunResult } from "../context.js";
import type { FailureClass } from "../contract.js";
import { COVER_PROMPT_FILE } from "../constants/paths.js";
import { IntegrationError } from "../integrations/http.js";
import { createOpenAiClient, generateCoverImage } from "../integrations/openai-image.js";
import { type DraftArticle, StrapiClient } from "../integrations/strapi.js";
import { logLine } from "../log.js";
import { resolveImageModel } from "../models/service.js";
import { jstDate } from "../time.js";

/** 結び待ち（アップロード済みで cover に結べなかった）の記事の印。値はアップロードしたファイルの id（結べたら消す） */
export const PENDING_KEY_PREFIX = "article-cover:pending:";

/** 記事ごとの、生成またはアップロードの連続の失敗回数。結べた・結び待ちに回せたら消す */
export const FAILURES_KEY_PREFIX = "article-cover:failures:";
/** 連続でこの回数失敗した記事は対象から外す */
export const MAX_CONSECUTIVE_FAILURES = 3;

const PLACEHOLDER_TITLE = "{{title}}";
const PLACEHOLDER_DESCRIPTION = "{{description}}";

/** 雛形の `{{title}}`・`{{description}}` を置き換えるだけ（置換文字列の `$` を解釈しないよう split/join を使う） */
export function buildCoverPrompt(template: string, article: { title: string; description: string }): string {
  return template.split(PLACEHOLDER_TITLE).join(article.title).split(PLACEHOLDER_DESCRIPTION).join(article.description).trim();
}

function skipped(reason: string): RunResult {
  return { outcome: "skipped", summary: `アイキャッチ画像の作成を見送った（${reason}）`, targetIds: [], skipReason: reason };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureClassOf(error: unknown): FailureClass {
  return error instanceof IntegrationError ? error.failureClass : "invalid_response";
}

export const articleCover: BuiltinHandler = async ({ ctx, runId, signal }): Promise<RunResult> => {
  const { config, kv } = ctx;
  if (!config.openai) return skipped("OPENAI_API_KEY が無い");
  if (!config.strapi) return skipped("CONTROL_STRAPI_URL・CONTROL_STRAPI_READ_TOKEN が無い");
  if (!config.strapi.writeToken) return skipped("CONTROL_STRAPI_WRITE_TOKEN が無い（アップロードできない）");
  const openai = config.openai;
  // 画像のモデル: 監視アプリの「実行モデル」の画面の選択 → 環境変数 CONTROL_OPENAI_IMAGE_MODEL（無ければ既定）。2026-11-12
  const imageModel = resolveImageModel(ctx.models, config) ?? openai.imageModel;

  // 雛形は承認済み main から読む。無い・空・差し込み先が無いときは、生成の費用を出す前に見送る
  let template: string;
  try {
    template = await readFile(join(config.mainCheckout, COVER_PROMPT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return skipped(`${COVER_PROMPT_FILE} が main のチェックアウトに無い`);
    logLine("ERROR", "article-cover", `雛形を読めなかった: ${errorText(error)}`, runId);
    return { outcome: "failure", summary: "プロンプトの雛形を読めなかった", targetIds: [], failureClass: "invalid_response" };
  }
  if (!template.includes(PLACEHOLDER_TITLE)) return skipped(`${COVER_PROMPT_FILE} に ${PLACEHOLDER_TITLE} が無い`);

  const strapi = new StrapiClient(config.strapi.baseUrl, config.strapi.readToken, config.strapi.writeToken);
  let drafts: DraftArticle[];
  try {
    drafts = await strapi.listDraftArticlesWithoutCover(signal);
  } catch (error) {
    if (error instanceof IntegrationError) {
      return { outcome: "failure", summary: `Strapi の下書きの記事を読めなかった（${error.failureClass}）`, targetIds: [], failureClass: error.failureClass };
    }
    throw error;
  }

  // 公開版の cover を引き継ぐだけの下書き（画像は作らないので、タイトルも失敗の回数も問わない）
  const inheritable = drafts.filter((draft) => draft.hasPublishedCover === true);
  const fresh = drafts.filter((draft) => draft.hasPublishedCover !== true);
  // タイトルが無い下書きはプロンプトを作れないので対象にしない（毎日の枠を取らないよう、件数で切る前に除く）
  const titled = fresh.filter((draft): draft is DraftArticle & { title: string } => (draft.title ?? "").trim() !== "");
  const untitled = fresh.length - titled.length;
  const pendingFileId = (draft: DraftArticle): number | null => {
    const value = kv.get(`${PENDING_KEY_PREFIX}${draft.documentId}`);
    return value && /^\d+$/.test(value) ? Number(value) : null;
  };
  const failureCount = (draft: DraftArticle): number => {
    const value = kv.get(`${FAILURES_KEY_PREFIX}${draft.documentId}`);
    return value && /^\d+$/.test(value) ? Number(value) : 0;
  };
  // 失敗が続く記事は対象から外す（枠を取らない）
  const eligible = titled.filter((draft) => failureCount(draft) < MAX_CONSECUTIVE_FAILURES);
  const dropped = titled.length - eligible.length;
  // 結び待ちの記事（引き継ぎの下書きで、結べなかったものを含む）は生成せず、結ぶことだけを再試行する
  const retryLink = [...inheritable, ...eligible].filter((draft) => pendingFileId(draft) !== null);
  const inheritNow = inheritable.filter((draft) => pendingFileId(draft) === null);
  // 古い順（updatedAt の昇順）に枠の分だけ。結び待ちの記事は生成しないので枠に数えない
  const toGenerate = eligible
    .filter((draft) => pendingFileId(draft) === null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))
    .slice(0, openai.maxPerRun);

  const excludedNotes = [
    untitled > 0 ? `タイトルの無い下書き ${untitled} 件は対象外` : null,
    dropped > 0 ? `失敗が続くため対象から外した記事 ${dropped} 件` : null,
  ].filter((line) => line !== null);

  const total = retryLink.length + inheritNow.length + toGenerate.length;
  if (total === 0) {
    return {
      outcome: "success",
      summary: excludedNotes.length > 0 ? `アイキャッチの対象の下書きは無かった（${excludedNotes.join("。")}）` : "アイキャッチの無い下書きは無かった",
      targetIds: [],
    };
  }

  let linked = 0;
  let inherited = 0;
  let pending = 0;
  let failed = 0;
  let firstFailureClass: FailureClass | null = null;
  const pendingIds: string[] = [];
  // アップロードが認証・権限で失敗したら、以降の生成は無駄になるので打ち切る
  let fatalClass: FailureClass | null = null;
  const bumpFailures = (documentId: string) => {
    const key = `${FAILURES_KEY_PREFIX}${documentId}`;
    const current = kv.get(key);
    kv.set(key, String((current && /^\d+$/.test(current) ? Number(current) : 0) + 1));
  };
  const fail = (documentId: string, stage: string, error: unknown) => {
    failed++;
    firstFailureClass ??= failureClassOf(error);
    logLine("WARN", "article-cover", `${documentId}: ${stage}に失敗（${errorText(error)}）`, runId);
  };

  /** cover に結ぶ。結べなければ結び待ちとして覚える（ファイルはアップロード済みで、人が結べる） */
  const link = async (documentId: string, fileId: number): Promise<void> => {
    // 生成とアップロードは済んでいる（結び待ちの再試行のときは、もとから失敗の記憶は無い）ので、失敗の連続は途切れる
    kv.delete(`${FAILURES_KEY_PREFIX}${documentId}`);
    try {
      await strapi.setArticleCover(documentId, fileId, signal);
      kv.delete(`${PENDING_KEY_PREFIX}${documentId}`);
      linked++;
    } catch (error) {
      kv.set(`${PENDING_KEY_PREFIX}${documentId}`, String(fileId));
      pendingIds.push(`cover-pending:${documentId}:${fileId}`);
      // 権限が無い（403）のは想定内で、失敗に数えない（人が結ぶ）。それ以外（接続・タイムアウトなど）は失敗にも数える
      if (error instanceof IntegrationError && error.failureClass === "permission_denied") pending++;
      else fail(documentId, "cover に結ぶこと", error);
    }
  };

  for (const draft of retryLink) {
    if (signal.aborted) break;
    await link(draft.documentId, pendingFileId(draft)!);
  }

  // 公開版の cover を下書きに結ぶ（画像は作らない。費用なし・枠に数えない）。公開版を読めない・cover が無くなっていたら、次回に回す
  let inheritSkipped = 0;
  for (const draft of inheritNow) {
    if (signal.aborted) break;
    let coverId: number | null = null;
    try {
      coverId = (await strapi.getArticle(draft.documentId, "published", signal))?.cover?.id ?? null;
    } catch (error) {
      fail(draft.documentId, "公開版の cover の取得", error);
      continue;
    }
    if (coverId === null) {
      inheritSkipped++;
      continue;
    }
    const before = linked;
    await link(draft.documentId, coverId);
    if (linked > before) inherited++;
  }

  const openaiClient = createOpenAiClient(openai.apiKey);
  const day = jstDate().replaceAll("-", "");
  for (const draft of toGenerate) {
    if (signal.aborted || fatalClass) break;
    const prompt = buildCoverPrompt(template, { title: draft.title, description: draft.description ?? "" });
    let image: Uint8Array;
    try {
      image = await generateCoverImage(openaiClient, prompt, imageModel, openai.imageSize, signal);
    } catch (error) {
      bumpFailures(draft.documentId);
      fail(draft.documentId, "画像の生成", error);
      continue;
    }
    let fileId: number;
    try {
      ({ id: fileId } = await strapi.uploadFile({ name: `cover-${draft.documentId}-${day}.png`, mime: "image/png", data: image }, signal));
    } catch (error) {
      bumpFailures(draft.documentId);
      fail(draft.documentId, "アップロード", error);
      const failureClass = failureClassOf(error);
      if (failureClass === "auth_failed" || failureClass === "permission_denied") fatalClass = failureClass;
      continue;
    }
    await link(draft.documentId, fileId);
  }

  // 停止要求・タイムアウトで残りを処理できなかった
  const processed = linked + pending + failed + inheritSkipped;
  const aborted = signal.aborted && !fatalClass && processed < total;
  if (aborted) {
    failed++;
    firstFailureClass ??= "timeout";
  }

  const summary = [
    `アイキャッチ: 結んだ ${linked}${inherited > 0 ? `（うち公開版の cover の引き継ぎ ${inherited}）` : ""}・結び待ち ${pending}・失敗 ${failed}（対象 ${total} 件）`,
    ...excludedNotes,
    fatalClass ? `アップロードが ${fatalClass} で失敗したため、残りの生成を打ち切った` : null,
    aborted ? "停止要求かタイムアウトで残りは次回に回した" : null,
  ]
    .filter((line) => line !== null)
    .join("。");
  // 認証・権限で打ち切ったときは、結べた記事があっても failure（設定の誤りで、人が直す必要がある）
  const outcome = fatalClass || (failed > 0 && linked + pending === 0) ? "failure" : failed > 0 ? "partial" : "success";
  return {
    outcome,
    summary,
    targetIds: pendingIds,
    failureClass: fatalClass ?? (failed === 0 ? null : firstFailureClass),
    // 生成を 1 回でも試したときだけ、使ったモデルを残す（結び直し・引き継ぎだけの回は生成していない）
    model: toGenerate.length > 0 ? imageModel : null,
  };
};
