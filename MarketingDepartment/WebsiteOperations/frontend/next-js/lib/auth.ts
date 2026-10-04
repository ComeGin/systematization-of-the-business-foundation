// 監視アプリのログイン（Better Auth）。メールとパスワード。
// DB は CONTROL_DATA_DIR/auth.sqlite（E-15 の e15.sqlite とは別のファイル）。
// 最初の管理者を作ったら新規登録を閉じる（ユーザーが 1 人でもいれば、サインアップは拒否される）。
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { nextCookies } from "better-auth/next-js";
import { openAuthDatabase, resolveDataDir } from "control-plane";

const DEFAULT_URL = "http://127.0.0.1:3200";

function create() {
  // node:sqlite を直接 import しない（開く処理は control-plane 側）
  const db = openAuthDatabase(resolveDataDir());
  const baseURL = process.env.BETTER_AUTH_URL?.trim() || DEFAULT_URL;
  const auth = betterAuth({
    database: db,
    baseURL,
    // 127.0.0.1 と localhost のどちらで開いても、同じオリジンとして扱う
    trustedOrigins: [baseURL, baseURL.replace("127.0.0.1", "localhost")],
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    // スキーマは ensureAuthSchema() で自分で作る。作る前の起動時検査が「テーブルが無い」と誤報するのを止める
    advanced: { database: { validateSchema: false } },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const row = db.prepare('SELECT count(*) AS n FROM "user"').get() as { n: number };
            if (row.n > 0) {
              throw new APIError("FORBIDDEN", { message: "新規登録は閉じています" });
            }
            return { data: user };
          },
        },
      },
    },
    // nextCookies はプラグインの最後に置く
    plugins: [nextCookies()],
  });
  return { auth, db };
}

declare global {
  var __comeginAuth: ReturnType<typeof create> | undefined;
  var __comeginAuthSchema: Promise<void> | undefined;
}

function instance() {
  globalThis.__comeginAuth ??= create();
  return globalThis.__comeginAuth;
}

export function getAuth() {
  return instance().auth;
}

/** Better Auth のテーブルを作る・更新する。最初のリクエストの前に 1 回だけ行う。 */
export function ensureAuthSchema(): Promise<void> {
  globalThis.__comeginAuthSchema ??= (async () => {
    const { runMigrations } = await getMigrations(getAuth().options);
    await runMigrations();
  })().catch((error: unknown) => {
    globalThis.__comeginAuthSchema = undefined; // 失敗したら次のリクエストで再試行する
    throw error;
  });
  return globalThis.__comeginAuthSchema;
}

/** 登録済みのユーザー数。0 のときだけ /setup（最初の管理者の作成）を開く。 */
export async function countUsers(): Promise<number> {
  await ensureAuthSchema();
  const row = instance().db.prepare('SELECT count(*) AS n FROM "user"').get() as { n: number };
  return row.n;
}
