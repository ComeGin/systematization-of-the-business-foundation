// E2E のログイン。Google の画面はオンプレの外なので通さず、サンドボックスのログイン用の SQLite（CONTROL_DATA_DIR/auth.sqlite）に
// 本物の Better Auth でユーザーとセッションを作り、ブラウザに Cookie として渡す（結合テストの integration/helpers/harness.ts と同じ考え方）。
// Cookie の署名は Better Auth と同じ（HMAC-SHA256、base64）。秘密は E2E だけの値（sandbox.mjs の AUTH_SECRET）。
//
// ここで作るインスタンスは databaseHooks（許可リストの検査）を持たない。許可リストに無いメールのセッションも作れるので、
// 「作成済みのセッションでも、許可リストに無ければ要求ごとに失効させる」（lib/session.ts）を確かめられる。
import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { openAuthDatabase } from "control-plane";
import { AUTH_SECRET, BASE_URL, DATA_DIR } from "./sandbox.mjs";

type Auth = ReturnType<typeof create>;

function create() {
  return betterAuth({
    database: openAuthDatabase(DATA_DIR),
    baseURL: BASE_URL,
    secret: AUTH_SECRET,
    emailAndPassword: { enabled: false },
    advanced: { database: { validateSchema: false } },
  });
}

let auth: Auth | undefined;
let migrated: Promise<void> | undefined;

async function instance(): Promise<Auth> {
  auth ??= create();
  // 監視アプリも最初の要求で同じ移行をする（冪等）。どちらが先でもよい
  migrated ??= getMigrations(auth.options).then(({ runMigrations }) => runMigrations());
  await migrated;
  return auth;
}

export interface SessionCookie {
  name: string;
  value: string;
}

/** Google のログインの後と同じく、ユーザー（無ければ作る）とセッションを作り、セッションの Cookie を返す */
export async function createSession(email: string): Promise<SessionCookie> {
  const ctx = await (await instance()).$context;
  const user =
    (await ctx.internalAdapter.findUserByEmail(email))?.user ??
    (await ctx.internalAdapter.createUser(
      { email, name: email.split("@")[0], emailVerified: true },
      { method: "oauth", oauth: { providerId: "google" } },
    ));
  const session = await ctx.internalAdapter.createSession(user.id, false);
  const signature = createHmac("sha256", ctx.secret).update(session.token).digest("base64");
  return { name: ctx.authCookies.sessionToken.name, value: encodeURIComponent(`${session.token}.${signature}`) };
}

/** Playwright の storageState の形（127.0.0.1 の Cookie 1 つ） */
export function storageStateOf(cookie: SessionCookie) {
  return {
    cookies: [
      {
        ...cookie,
        domain: "127.0.0.1",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };
}

/** API を直接呼ぶときの cookie の見出し */
export const cookieHeader = (cookie: SessionCookie) => `${cookie.name}=${cookie.value}`;
