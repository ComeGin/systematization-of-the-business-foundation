import type { DatabaseSync } from "node:sqlite";
import type { ModelSettingChange, ModelSettingScope } from "../contract.js";
import { toIsoJst } from "../time.js";
import { transaction } from "./db.js";

/** 画面で選んだ実行モデル（2026-11-12）。scope ごとに 1 行。行が無い scope は「選んでいない」（定義・環境変数の値を使う） */
export interface ModelSettingRow {
  scope: ModelSettingScope;
  model: string;
  actor: string;
  updatedAt: string;
}

const HISTORY_LIMIT = 50;

/**
 * 実行モデルの選択と、その変更の履歴。書くのは監視アプリのサーバー側だけ（画面の操作から。エージェントには書かせない）。
 * scope の形: "anthropic:default"（全体の既定）・"anthropic:agent:<名前>"（エージェントごと）・"openai:image"（アイキャッチ画像）
 */
export class ModelSettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): ModelSettingRow[] {
    const rows = this.db.prepare("SELECT scope, model, actor, updated_at FROM model_settings ORDER BY scope").all() as {
      scope: string;
      model: string;
      actor: string;
      updated_at: string;
    }[];
    return rows.map((row) => ({ scope: row.scope as ModelSettingScope, model: row.model, actor: row.actor, updatedAt: row.updated_at }));
  }

  get(scope: ModelSettingScope): string | null {
    const row = this.db.prepare("SELECT model FROM model_settings WHERE scope = ?").get(scope) as { model: string } | undefined;
    return row?.model ?? null;
  }

  /** model が null なら選択を外す（定義・環境変数の値に戻す）。変更が無ければ何もしない。履歴は同じトランザクションで残す */
  set(scope: ModelSettingScope, model: string | null, actor: string): void {
    const previous = this.get(scope);
    if (previous === model) return;
    const at = toIsoJst();
    transaction(this.db, () => {
      if (model === null) {
        this.db.prepare("DELETE FROM model_settings WHERE scope = ?").run(scope);
      } else {
        this.db
          .prepare(
            `INSERT INTO model_settings (scope, model, actor, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (scope) DO UPDATE SET model = excluded.model, actor = excluded.actor, updated_at = excluded.updated_at`,
          )
          .run(scope, model, actor, at);
      }
      this.db
        .prepare("INSERT INTO model_setting_changes (scope, model, previous, actor, at) VALUES (?, ?, ?, ?, ?)")
        .run(scope, model, previous, actor, at);
    });
  }

  /** 変更の履歴（新しい順。最大 50 件） */
  history(): ModelSettingChange[] {
    const rows = this.db
      .prepare("SELECT scope, model, previous, actor, at FROM model_setting_changes ORDER BY id DESC LIMIT ?")
      .all(HISTORY_LIMIT) as { scope: string; model: string | null; previous: string | null; actor: string; at: string }[];
    return rows.map((row) => ({ scope: row.scope as ModelSettingScope, model: row.model, previous: row.previous, actor: row.actor, at: row.at }));
  }
}
