#!/usr/bin/env node
/**
 * chatwoot-mcp-server の動作確認。
 *
 *   pnpm verify              参照のみ（Chatwoot の状態を変えない）
 *   pnpm verify --write      テストデータを作って一連の運用を再現し、最後に削除する
 *   pnpm verify --write --keep   作ったデータを残す（調査用）
 *   pnpm verify --verbose    各ツールの応答も表示する
 *
 * 環境変数は .env から読む（package.json の verify スクリプト）。
 * --write は実際に Chatwoot へ書き込むため、本番アカウントに向けて実行しないこと。
 */
import { existsSync } from "node:fs";

import { Harness, SERVER_ENTRY } from "./harness.mts";
import { readChecks, writeChecks } from "./scenarios.mts";

// `pnpm verify -- --write` のように渡されると "--" が混ざるため取り除く
const args = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
const withWrite = args.has("--write");
const keep = args.has("--keep");
const verbose = args.has("--verbose");

const unknown = [...args].filter((arg) => !["--write", "--keep", "--verbose"].includes(arg));
if (unknown.length > 0) {
  console.error(`不明なオプション: ${unknown.join(", ")}（--write / --keep / --verbose）`);
  process.exit(2);
}

if (!existsSync(SERVER_ENTRY)) {
  console.error(`${SERVER_ENTRY} がありません。先に pnpm build を実行してください。`);
  process.exit(2);
}
for (const key of ["CHATWOOT_BASE_URL", "CHATWOOT_API_ACCESS_TOKEN", "CHATWOOT_ACCOUNT_ID"]) {
  if (!process.env[key]) {
    console.error(`環境変数 ${key} が設定されていません（.env を確認してください）。`);
    process.exit(2);
  }
}

console.log(`Chatwoot: ${process.env.CHATWOOT_BASE_URL} / アカウント ${process.env.CHATWOOT_ACCOUNT_ID}`);
console.log(`モード: ${withWrite ? "参照 + 書き込み（テストデータを作成して削除します）" : "参照のみ"}`);

// 参照の確認はツールの公開範囲が最も狭い read_only で行い、書き込みの確認だけ full で行う
const reader = await Harness.start({ accessLevel: "read_only", verbose });
let failed = 0;
try {
  await readChecks(reader);
} finally {
  failed += reader.results.failed;
  await reader.close();
}

let writer: Harness | undefined;
if (withWrite) {
  writer = await Harness.start({ accessLevel: "full", keep, verbose });
  try {
    await writeChecks(writer);
  } catch (error) {
    // シナリオの途中で予期しない例外が出ても、後片付けまで進める
    console.log(`  ✗ 予期しないエラー: ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
  } finally {
    failed += writer.results.failed;
    await writer.close();
  }
}

const passed = reader.results.passed + (writer?.results.passed ?? 0);
const skipped = reader.results.skipped + (writer?.results.skipped ?? 0);
const failures = [...reader.results.failures, ...(writer?.results.failures ?? [])];

console.log(`\n結果: 成功 ${passed} / 失敗 ${failed}${skipped ? ` / スキップ ${skipped}` : ""}`);
for (const failure of failures) console.log(`  ✗ ${failure.name}: ${failure.detail}`);
if (!withWrite) console.log("書き込み系のツールは確認していません（--write で実行できます）。");

process.exit(failed > 0 ? 1 : 0);
