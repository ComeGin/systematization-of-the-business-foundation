// 「✗ 更新が必要」の項目の、詳しい直し方（端末の表示だけ。--json の結果と監視アプリの画面には載せない）。
// runner.mjs が、--check の最後と、実行（--check なし）で ✗ が出て止めるときに出す。
//
// 直し方は 3 つから組み立てる（上ほど優先）:
//   1. FIX_STEPS: 項目の key ごとの手順。デプロイ忘れの検知（cloud・onprem）の項目は止まる id を持たず、
//      根拠の文にはコマンドが 1 つ入っているだけなので、前後の手順（作業ツリーをそろえる・再起動・確かめ方）をここに書く
//   2. 止まる id（stopId）があれば、setup/manual-steps.md の 0 節（早見表）の行（いつ・何を・節）。監視アプリの「止まったとき」と同じ表
//   3. 段階（step。P2 など）があれば、setup/00-setup-overview.md の「### P<n>.」の見出し（詳しい手順の場所）
// どれも無ければ、根拠の文（evidence）だけになる（根拠の文の後半に直し方が書いてある）。
//
// 確かめ直すコマンドと続きから実行するコマンドは runner.mjs が足す（モジュール・段階・親スクリプトで変わるため）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stopIdsInCell } from "../status/verify-steps.mjs";
import { W } from "./core.mjs";

const MANUAL = "setup/manual-steps.md";
const OVERVIEW = "setup/00-setup-overview.md";

// 記録（DeployedCommit・イメージの rev タグ・ラベル）は HEAD のコミットで書かれ、origin/main と比べられる。
// main 以外の HEAD や未コミットの変更があると、包みのスクリプトが止まるか、記録が origin/main の履歴に無く「!」になる
const syncWorktree = (paths) =>
  `開発のリポジトリ（samconfig.toml・onprem の環境変数ファイルがある作業ツリー）を origin/main にそろえる: 作業中の変更はコミットか git stash で退ける → git fetch origin → git switch main && git pull --ff-only → git status で ${paths} に未コミットの変更が無いことを確かめる（あると包みのスクリプトが止まる。main 以外の HEAD でデプロイ・ビルドすると、記録が origin/main の履歴に無く「!」になる）`;

const ECS_AFTER_DEPLOY =
  "デプロイの後、ECS のサービスが動いているかを確かめる: node setup/setup.mjs --target prod --check --only cloud,chatwoot-prod（デプロイは昼〈3 時 45 分〜22 時〉に行う。夜間にデプロイすると Chatwoot が 0 台のまま残ることがあり、そのときは表示される aws ecs update-service … --desired-count で CloudFormation の値に戻す。cloud/README.md の 4.11）";

const DEPLOY_DEFAULT = [
  syncWorktree("cloud/・backend/faq-bot・backend/consent-api・backend/admin-auth"),
  "AWS の資格情報（本番のアカウント）が使える端末で、node cloud/deploy.mjs を実行する（sam build → sam deploy。変更セットが表示されたら中身を見て y で答える。生の sam deploy は使わない〈記録 DeployedCommit が前のままで、✗ が出続ける〉）",
  "CloudFormation で本番スタックが UPDATE_COMPLETE になったことを確かめる（UPDATE_ROLLBACK_COMPLETE なら、イベントで失敗の理由を見て直す。cloud/README.md の 4.12）",
  ECS_AFTER_DEPLOY,
];

/** 項目の key → 手順（文字列の配列。番号は runner が振る） */
export const FIX_STEPS = {
  "cloud.global-commit": [
    syncWorktree("cloud/"),
    "AWS の資格情報（本番のアカウント）が使える端末で、node cloud/deploy.mjs --config-env global を実行する（us-east-1 の CloudFront 用の ACM と WAF。sam deploy だけ。変更セットが表示されたら中身を見て y で答える）",
    "CloudFormation（us-east-1）で global のスタックが UPDATE_COMPLETE になったことを確かめる（cloud/README.md の 4.1）",
  ],
  "cloud.stack-commit": DEPLOY_DEFAULT,
  "cloud.lambda-code": DEPLOY_DEFAULT,
  "cloud.stack-params": [
    "上の行の「名前」のパラメータについて、cloud/samconfig.toml の値が正しいかを確かめる（スタックを手で変えたのなら、samconfig.toml の側を正しい値に直す。値は画面に出さない）",
    "本番スタックの名前が出ていれば node cloud/deploy.mjs、global の名前が出ていれば node cloud/deploy.mjs --config-env global で反映する（変更セットに y で答える）",
    ECS_AFTER_DEPLOY,
  ],
  "cloud.image-commit": [
    syncWorktree("cloud/images/<製品>"),
    "上の行で ✗ の製品（Chatwoot・Mautic）ごとに、cloud/samconfig.toml の ChatwootImageTag・MauticImageTag の連番を 1 つ上げる（ECR のタグは上書きできない。同じタグのままだと push が拒否される）",
    "ECR にログインする: aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin <アカウント>.dkr.ecr.ap-northeast-1.amazonaws.com",
    "node cloud/images/build-push.mjs chatwoot（または mautic。✗ の製品だけ）。<タグ> と <タグ>-rev-<コミット> の 2 つが push される",
    "push が終わってから node cloud/deploy.mjs（順番を逆にすると、ECR に無いタグのタスクを起動できず、スタックごと UPDATE_ROLLBACK になる。cloud/README.md の 4.7・4.12）",
    ECS_AFTER_DEPLOY,
  ],
  "onprem.strapi-image": [
    syncWorktree("backend/strapi-system・onprem/strapi"),
    "node onprem/build.mjs strapi（生の docker compose build は使わない〈ビルドしたコミットのラベルが付かず、✗ が出続ける〉）",
    "sudo systemctl restart comegin-strapi（ビルドしただけでは動いているコンテナは入れ替わらない）",
    "systemctl status comegin-strapi が active (running) になったことを確かめる（127.0.0.1:1338 の待ち受けは、下の「確かめ直す」で見る）",
  ],
  "onprem.n8n-image": [
    syncWorktree("onprem/n8n"),
    "node onprem/build.mjs n8n（生の docker compose build は使わない〈ビルドしたコミットのラベルが付かず、✗ が出続ける〉）",
    "sudo systemctl restart comegin-n8n（ビルドしただけでは動いているコンテナは入れ替わらない）",
    "systemctl status comegin-n8n が active (running) になったことを確かめる（127.0.0.1:5679 の待ち受けは、下の「確かめ直す」で見る）",
  ],
  "onprem.n8n-version": [
    syncWorktree("onprem/n8n"),
    "onprem/n8n/.env.example（origin/main の雛形）の N8N_VERSION・N8N_DIGEST・N8N_RUNNERS_DIGEST の 3 つが onprem/n8n の環境変数ファイルと違えば、雛形の値を同じ行に写す（「いまの状態」が版・ダイジェストの違いでなく「記録が無い」だけなら写さなくてよい。ほかの行は変えない。N8N_ENCRYPTION_KEY を変えると既存のデータを復号できなくなる）",
    "node onprem/build.mjs n8n",
    "sudo systemctl restart comegin-n8n（n8n と runners の版は必ずそろえる。compose が両方を作り直す）",
    "systemctl status comegin-n8n が active (running) になったことを確かめる（127.0.0.1:5679 の待ち受けは、下の「確かめ直す」で見る）",
  ],
};

/** Markdown のリンクを文字だけにする（端末ではリンクにならないため） */
const unlink = (s) => s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");

let stopTable;
/** setup/manual-steps.md の 0 節（早見表）の 止まる id → { when, what, section }。読めなければ空 */
export function stopGuides(root = W) {
  if (stopTable && root === W) return stopTable;
  const table = {};
  const file = join(root, MANUAL);
  if (existsSync(file)) {
    const lines = readFileSync(file, "utf8").split("\n");
    const start = lines.findIndex((l) => /^## 0\. 早見表/.test(l));
    let separatorSeen = false;
    for (const line of start < 0 ? [] : lines.slice(start + 1)) {
      if (/^## /.test(line)) break;
      if (!line.startsWith("|")) continue;
      if (/^\|[\s:|-]+\|?\s*$/.test(line)) {
        separatorSeen = true;
        continue;
      }
      if (!separatorSeen) continue;
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length < 4) continue;
      const [ids, when, what, section] = cells;
      for (const id of stopIdsInCell(ids)) table[id] ??= { when: unlink(when), what: unlink(what), section: unlink(section) };
    }
  }
  if (root === W) stopTable = table;
  return table;
}

/** setup/00-setup-overview.md の「### P<n>.」の見出しの文字（無ければ null） */
export function overviewHeading(step, root = W) {
  if (!step) return null;
  const file = join(root, OVERVIEW);
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`### ${step}. `));
  return line ? line.slice(4).replaceAll("`", "").trim() : null;
}

/**
 * 項目 1 つの直し方。{ steps: string[], refs: string[] }。
 * steps は番号を振って出す手順、refs は「詳しくは」の参照（早見表の行・概要の節）
 */
export function fixGuide(item, { level = "action", root = W } = {}) {
  const refs = [];
  // 警告（!）は、根拠の文に書いてある対応が先。key の手順は ✗ のときのやり直しの手順なので、参考として後ろに付ける
  // （例: 記録のコミットが origin/main の履歴に無い → まず git fetch。それでも残れば、main で記録付きでやり直す）
  if (level === "warn") {
    const steps = [
      item.evidence
        ? "上の「いまの状態」の文に書いてある対応を行う（git fetch・雛形の更新など）。対応が要らない状態だと判断したなら、その判断で進めてよい"
        : "上の文に書いてある対応を行う。対応が要らない状態だと判断したなら、その判断で進めてよい",
      ...(FIX_STEPS[item.key] ?? []).map((s) => `（やり直すときの参考）${s}`),
    ];
    if (item.stopId) refs.push(`${MANUAL} の 0 節（早見表）の ${item.stopId}`);
    const heading = overviewHeading(item.step, root);
    if (heading) refs.push(`${OVERVIEW} の「${heading}」`);
    return { steps, refs };
  }
  const steps = [...(FIX_STEPS[item.key] ?? [])];
  if (item.stopId) {
    const g = stopGuides(root)[item.stopId];
    if (g) {
      if (!steps.length) steps.push(`${g.what}（止まる id ${item.stopId}。いつ: ${g.when}）`);
      refs.push(`${MANUAL} の ${g.section} 節（早見表の ${item.stopId}）`);
    } else {
      refs.push(`${MANUAL} の 0 節（早見表）で ${item.stopId} を引く`);
    }
  }
  if (!steps.length) steps.push("上の「いまの状態」の文の後半に書いてある直し方を行う");
  const heading = overviewHeading(item.step, root);
  if (heading) refs.push(`${OVERVIEW} の「${heading}」`);
  return { steps, refs };
}
