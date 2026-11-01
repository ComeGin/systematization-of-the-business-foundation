// GA4（アクセス解析の正本。ADR-25）の設定。本番のプロパティの ID と測定 ID が設定にあり、形式が正しいかを確かめるだけ。
//
// target ごとの違い:
//   - --target dev: 開発の Astro の環境変数に測定 ID が無いことだけを確かめる。本番のプロパティの作成と ID の確認は飛ばす
//     （開発の時点では公開サイトが AWS に展開されておらず、本番のプロパティにはまだ送るものも読むものも無い）
//   - --target prod（段階 google。公開サイトが Route 53 から配信された後に --phase google で明示したときだけ動く）:
//     本番のプロパティの作成（ga4:property）と、2 つの値の形式の確認
//
// 方針（setup/lib/core.mjs の契約）:
//   - GA4 は Google の SaaS で、動かすものが無い。プロパティは本番の 1 つだけで、作るのも設定するのも画面の操作（ctx.manual）
//   - GA4 の API は呼ばない（Admin API で確かめるには analytics.readonly の OAuth が要り、それは OpenSEO の接続の側で持つ。
//     ここでは設定値の形式だけを見る。タイムゾーン・通貨・データ保持などはプロパティの作成の手順で頼み、README の 1 節を正にする）
//   - 開発の公開サイト（astro dev）にはタグを出さない（ユーザーの決定）。開発の Astro の環境変数に PUBLIC_GA4_MEASUREMENT_ID があれば失敗にする。
//     画面の操作ではなく設定の誤りなので manual ではなく例外（manual の id は ga4:property だけ。setup/manual-steps.md の早見表）。
//     環境変数ファイルは読むだけで、書き換えない（消すのは人）
//   - OpenSEO から GA4 を読む接続（OPENSEO_GA4_CONNECTED／OPENSEO_SKIP_GA4）は openseo モジュールが扱う
//
// 設定のキー（~/.config/comegin/setup/prod.conf。雛形は setup/setup.conf.example。どちらも秘密値ではない）:
//   GA4_PROPERTY_ID      本番のプロパティの ID（数字だけ）
//   GA4_MEASUREMENT_ID   本番の Web ストリームの測定 ID（G- で始まる）
//
// 確かめた出典:
//   https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties（プロパティの名前は properties/{数字}。timeZone・currencyCode）
//   https://developers.google.com/tag-platform/security/concepts/consent-mode（basic は同意の前にタグを読み込まない）
//   https://vite.dev/guide/env-and-mode#env-files（開発〈mode=development〉で読むのは .env・.env.local・.env.development・.env.development.local）
//   middleware/ga4/README.md（プロパティの設定値・タグ・CSP・OpenSEO の接続。ほかの出典もここ）
import { join } from "node:path";

export const meta = { id: "ga4", title: "GA4（アクセス解析の正本。本番のプロパティの設定値）", targets: ["dev", "prod"], phases: ["google"], after: [] };

const SITE_DIR = "frontend/verdant-virgo";
const DEV_ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"]; // Vite が開発で読む順
const TAG_ENV = "PUBLIC_GA4_MEASUREMENT_ID";
const PROPERTY_ID = /^\d+$/;
const MEASUREMENT_ID = /^G-[A-Z0-9]+$/;

// ---------------------------------------------------------------------------
// 値の確かめ
// ---------------------------------------------------------------------------

/** 設定の 2 つの値を確かめる。問題ごとに 1 行の文を返す（無ければ空） */
function configProblems(ctx) {
  const problems = [];
  const property = ctx.value("GA4_PROPERTY_ID");
  const measurement = ctx.value("GA4_MEASUREMENT_ID");
  if (!property) problems.push("GA4_PROPERTY_ID が設定に無い");
  else if (!PROPERTY_ID.test(property)) problems.push("GA4_PROPERTY_ID が数字だけになっていない（properties/ や測定 ID を書いていないか）");
  if (!measurement) problems.push("GA4_MEASUREMENT_ID が設定に無い");
  else if (!MEASUREMENT_ID.test(measurement)) problems.push("GA4_MEASUREMENT_ID が G- で始まる英大文字・数字になっていない");
  return problems;
}

/** 開発の Astro の環境変数ファイルのうち、測定 ID を書いてあるもの（W からの相対パス） */
function devTagFiles(ctx) {
  return DEV_ENV_FILES.map((f) => join(SITE_DIR, f)).filter((rel) => Boolean(ctx.readEnvFile(join(ctx.W, rel))[TAG_ENV]));
}

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

function propertySteps() {
  return [
    "https://analytics.google.com/ を開き、管理 → 作成 → プロパティ で本番のプロパティを作る（アカウントが無ければ先に作る。開発用のプロパティは作らない）。レポートのタイムゾーンは 日本（Asia/Tokyo）、通貨は 日本円（JPY）",
    "続けて Web データストリームを作る（URL は https://comegin.com）。拡張計測の歯車で、ページビュー（ブラウザの履歴の変更を含む）・スクロール数・離脱クリック・サイト内検索・ファイルのダウンロードをオン、フォームの操作と動画エンゲージメントをオフにする（フォームの CV の正本は Mautic）",
    "管理 → データの収集と修正 → データの保持 で、イベントデータとユーザーデータの保持をどちらも 14 か月にして保存する",
    "管理 → データの収集と修正 → データ収集 で、Google シグナルのデータ収集とユーザー提供データの収集がどちらもオフであることを確かめる（オンなら切る）",
    "管理 → サービス間のリンク設定 で、Google 広告などのリンクを作らない",
    "管理 → プロパティの設定 → プロパティの詳細 の「プロパティ ID」（数字）と、データストリームの「測定 ID」（G- で始まる）を ~/.config/comegin/setup/prod.conf に GA4_PROPERTY_ID=… と GA4_MEASUREMENT_ID=… として書く（chmod 600。どちらも秘密値ではない）",
    "詳しい設定値と理由は middleware/ga4/README.md の 1 節。書いたら、同じコマンドを実行し直す",
  ];
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

const isProd = (ctx) => ctx.target === "prod";
const PROPERTY_SKIPPED_IN_DEV = "本番の GA4 プロパティの手順は開発では飛ばす（公開サイトが AWS に無い）。公開サイトが Route 53 から配信された後に node setup/setup.mjs --target prod --phase google で行う";

export async function check(ctx) {
  if (!isProd(ctx)) {
    const files = devTagFiles(ctx);
    const note = files.length ? `開発の Astro の環境変数に ${TAG_ENV} がある（${files.join("、")}。開発ではタグを出さない）` : `開発の Astro の環境変数に ${TAG_ENV} は無い`;
    return { ok: files.length === 0, notes: [note, PROPERTY_SKIPPED_IN_DEV] };
  }
  const problems = configProblems(ctx);
  const notes = problems.length ? [...problems] : [`本番のプロパティ ${ctx.value("GA4_PROPERTY_ID")}／測定 ID ${ctx.value("GA4_MEASUREMENT_ID")}（形式だけを確かめた。プロパティの設定は画面で確かめる）`];
  return { ok: problems.length === 0, notes };
}

export async function apply(ctx) {
  if (isProd(ctx)) {
    const problems = configProblems(ctx);
    if (problems.length) {
      for (const p of problems) ctx.warn(p);
      ctx.manual("property", "本番の GA4 プロパティを作り（設定済みなら確かめ）、プロパティ ID と測定 ID を設定に書く", propertySteps());
    }
    ctx.log(`本番のプロパティ ${ctx.value("GA4_PROPERTY_ID")}／測定 ID ${ctx.value("GA4_MEASUREMENT_ID")}（形式は正しい。本番のビルドに PUBLIC_GA4_MEASUREMENT_ID として渡す。cloud/README.md の 4.14）`);
    ctx.log("終わった。OpenSEO からの読み取りの接続は openseo モジュール（OPENSEO_GA4_CONNECTED）");
    return;
  }

  const files = devTagFiles(ctx);
  if (files.length) {
    throw new Error(
      `開発の公開サイトの環境変数ファイル（${files.join("、")}）に ${TAG_ENV} がある。開発ではタグを出さないので、その行を消し、astro dev を動かしていれば起動し直してから --from ga4 で実行し直す（測定 ID は本番のビルドにだけ渡す）`,
    );
  }

  ctx.log("開発の Astro には測定 ID が無い（開発ではタグを出さない）");
  ctx.log(PROPERTY_SKIPPED_IN_DEV);
}
