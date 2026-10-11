// 監視アプリのログイン（Better Auth）。Google（Workspace）だけ。メールとパスワードのログインは持たない（ADR-23）。
// DB は CONTROL_DATA_DIR/auth.sqlite（E-15 の e15.sqlite とは別のファイル）。
//
// 開発では ngrok で外に出す（ADR-23）ため、通す条件を 3 段にしてある（backend/admin-auth/src/auth.ts と同じ考え方）。どれか 1 つが漏れても通らない。
//  1. Google プロバイダーの hd（ライブラリが ID トークンの hd クレームを検査する。hd が無いトークンは拒否）
//  2. mapProfileToUser（Google の profile の hd と email_verified を、このアプリが自前で検査する）
//  3. databaseHooks（メールが Workspace のドメインで、許可リスト CONTROL_ADMIN_EMAILS にあるときだけ、ユーザーとセッションを作る）
// 加えて、要求ごとに同じ検査（isAdminEmail）をする（lib/session.ts）。許可リストから外した人の作成済みのセッションは、次の要求で失効させる。
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { nextCookies } from "better-auth/next-js";
import { openAuthDatabase, resolveDataDir } from "control-plane";

const DEFAULT_URL = "http://127.0.0.1:3200";
const DEFAULT_HOSTED_DOMAIN = "comegin.com";
const LOGIN_REFUSED_MESSAGE = "このアカウントでは監視アプリにログインできません";

/** 許可リスト（カンマ区切りのメールアドレス。小文字で比べる）。空ならだれも通さない */
function allowlist(): Set<string> {
  return new Set(
    (process.env.CONTROL_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function hostedDomain(): string {
  return process.env.GOOGLE_HOSTED_DOMAIN?.trim() || DEFAULT_HOSTED_DOMAIN;
}

/** 監視アプリを使ってよいメールか（Workspace のドメインで、許可リストにある）。作成時の検査と要求ごとの検査で同じものを使う */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return lower.endsWith(`@${hostedDomain()}`) && allowlist().has(lower);
}

/** Google の資格情報が入っているか。無ければログインの画面に案内を出す（ログインはできない） */
export function isGoogleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

function create() {
  // node:sqlite を直接 import しない（開く処理は control-plane 側）
  const db = openAuthDatabase(resolveDataDir());
  const baseURL = process.env.BETTER_AUTH_URL?.trim() || DEFAULT_URL;
  const domain = hostedDomain();

  const refuse = (reason: string): never => {
    // メールアドレスは記録しない（理由の種類だけ）
    console.error(`[auth] login refused: ${reason}`);
    throw new APIError("FORBIDDEN", { message: LOGIN_REFUSED_MESSAGE });
  };
  const assertAdminEmail = (email: string | null | undefined): void => {
    if (!email) return refuse("no email");
    const lower = email.toLowerCase();
    if (!lower.endsWith(`@${domain}`)) return refuse("email is outside the workspace domain");
    if (!allowlist().has(lower)) return refuse("email is not on the allowlist");
  };

  const auth = betterAuth({
    database: db,
    baseURL,
    // 127.0.0.1 と localhost のどちらで開いても、同じオリジンとして扱う（ngrok の URL のときは置き換えが起きず、その URL だけ）
    trustedOrigins: [baseURL, baseURL.replace("127.0.0.1", "localhost")],
    emailAndPassword: { enabled: false },
    socialProviders: isGoogleConfigured()
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID!.trim(),
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
            hd: domain,
            prompt: "select_account" as const,
            mapProfileToUser: (profile: { hd?: string; email_verified?: boolean }) => {
              if (profile.hd !== domain) refuse("hd claim does not match");
              if (profile.email_verified !== true) refuse("email is not verified");
              return {};
            },
          },
        }
      : {},
    // 以前のメールとパスワードのユーザー（同じメール）がいれば、Google のアカウントをそこにつなぐ
    account: { encryptOAuthTokens: true, accountLinking: { enabled: true, trustedProviders: ["google"] } },
    // ログインに失敗したときの行き先（?error=… を付けて戻る。Better Auth の既定のエラーページは使わない）
    onAPIError: { errorURL: "/login" },
    // ngrok で外に出すので、開発でも回数の制限をかける（Better Auth の既定は本番だけ）
    rateLimit: { enabled: true, window: 60, max: 100, customRules: { "/sign-in/social": { window: 60, max: 10 } } },
    advanced: {
      // スキーマは ensureAuthSchema() で自分で作る。作る前の起動時検査が「テーブルが無い」と誤報するのを止める
      database: { validateSchema: false },
      // ngrok の配下では送信元 IP が X-Forwarded-For に入る（回数の制限の単位）
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            assertAdminEmail(user.email);
            return { data: user };
          },
        },
      },
      session: {
        create: {
          // 許可リストから外された人は、既存のユーザーでも新しいセッションを作れない（作成済みのセッションは lib/session.ts が要求ごとに失効させる）。
          // DB のユーザーの行からメールを引く
          before: async (session) => {
            const row = db.prepare('SELECT email FROM "user" WHERE id = ?').get(session.userId) as { email?: string } | undefined;
            assertAdminEmail(row?.email);
            return { data: session };
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
