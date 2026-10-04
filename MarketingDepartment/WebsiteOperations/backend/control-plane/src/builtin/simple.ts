// 小さな builtin（heartbeat・runlog-flush・published-article-check）。lighthouse は子プロセスを起動するため別ファイル。
import type { BuiltinHandler } from "../context.js";
import { classifyAwsError, createCloudWatchClient, putHeartbeat } from "../integrations/aws.js";

/** 定義から起動されたハートビート（通常は 5 分ごとの内部タイマーが送る。E-15 には記録しない）。 */
export const heartbeat: BuiltinHandler = async ({ ctx, signal }) => {
  const aws = ctx.config.aws;
  if (!aws) throw new Error("AWS の設定が無い");
  try {
    await putHeartbeat(createCloudWatchClient(aws), aws, signal);
    return { outcome: "success", summary: "ハートビートを送信した", targetIds: [] };
  } catch (error) {
    return {
      outcome: "failure",
      summary: "ハートビートの送信に失敗した",
      targetIds: [],
      failureClass: classifyAwsError(error),
    };
  }
};

export const runlogFlush: BuiltinHandler = async ({ ctx, signal }) => {
  if (!ctx.copier) throw new Error("AWS の設定が無い");
  const result = await ctx.copier.flush(signal);
  if (result.failureClass) {
    return {
      outcome: result.sent + result.alreadyCopied > 0 ? "partial" : "failure",
      summary: `S3 への写し: 送信 ${result.sent} 件、残り ${result.remaining} 件`,
      targetIds: [],
      failureClass: result.failureClass,
    };
  }
  return {
    outcome: "success",
    summary: `S3 への写し: 送信 ${result.sent} 件（写し済み ${result.alreadyCopied} 件）`,
    targetIds: [],
  };
};

/**
 * 公開された記事の確認（雛形）。
 * TODO: 本番の Strapi を読み、前回から公開された記事があればビルドと計測を起こす（TA-07 の 3.5、DD-05 の 3.2）。
 * 非公開化と削除の検知（TA-07 の 9 節）と、Strapi を読む資格情報の置き場もあわせて決める。
 */
export const publishedArticleCheck: BuiltinHandler = async () => ({
  outcome: "skipped",
  summary: "公開された記事の確認は未実装のため見送った",
  targetIds: [],
  skipReason: "published-article-check は未実装（TA-07 の 3.5・DD-05 の 3.2）",
});
