import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import type pg from "pg";
import { findUserEmail, isAllowlisted } from "./allowlist.js";
import type { Config } from "./config.js";
import {
  AUTH_BASE_PATH,
  CONSENT_PATH,
  ERROR_PATH,
  OIDC_SCOPES,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  SIGN_IN_PATH,
} from "./constants.js";

const LOGIN_REFUSED_MESSAGE = "このアカウントでは管理画面にログインできません";

/**
 * 管理者の認証・認可の設定。通す条件は 3 段で、どれか 1 つが漏れても通らないようにしてある。
 *  1. Google プロバイダーの hd（ライブラリが ID トークンの hd クレームを検査する。hd が無いトークンは拒否）
 *  2. mapProfileToUser（Google の profile の hd と email_verified を、このサービスが自前で検査する）
 *  3. databaseHooks（メールが Workspace のドメインで、許可リストの表にあるときだけ、ユーザーとセッションを作る）
 */
export function createAuthOptions(config: Config, pool: pg.Pool) {
  const domain = config.GOOGLE_HOSTED_DOMAIN;

  const refuse = (reason: string): never => {
    // メールアドレスは記録しない（理由の種類だけ）
    console.error(`[auth] login refused: ${reason}`);
    throw new APIError("FORBIDDEN", { message: LOGIN_REFUSED_MESSAGE });
  };

  const assertAdminEmail = async (email: string | null | undefined): Promise<void> => {
    if (!email) return refuse("no email");
    if (!email.toLowerCase().endsWith(`@${domain}`)) return refuse("email is outside the workspace domain");
    if (!(await isAllowlisted(pool, email))) return refuse("email is not on the allowlist");
  };

  return {
    baseURL: config.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: config.BETTER_AUTH_SECRET,
    database: pool,
    trustedOrigins: [config.BETTER_AUTH_URL],
    // OAuth Provider 利用時に必須。トークンの発行は /oauth2/token が担う
    disabledPaths: ["/token"],
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    // Google のアクセストークン・ID トークンは使わないが、DB には暗号化して置く
    account: { encryptOAuthTokens: true },
    // ログインに失敗したときの行き先（Better Auth の既定のエラーページは使わない）
    onAPIError: { errorURL: ERROR_PATH },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { "/sign-in/social": { window: 60, max: 10 } },
    },
    advanced: {
      // ALB の配下では送信元 IP が X-Forwarded-For に入る
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    socialProviders:
      config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: config.GOOGLE_CLIENT_ID,
              clientSecret: config.GOOGLE_CLIENT_SECRET,
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
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email?: string | null }) => {
            await assertAdminEmail(user.email);
          },
        },
      },
      session: {
        create: {
          // 許可リストから外された人は、既存のユーザーでも新しいセッションを作れない。
          // エンドポイントの外から呼ばれても効くよう、コンテキストではなく DB のユーザーの行からメールを引く
          before: async (session: { userId: string }) => {
            await assertAdminEmail(await findUserEmail(pool, session.userId));
          },
        },
      },
    },
    plugins: [
      // OAuth Provider を使うときは、JWT プラグイン側の /token と set-auth-jwt ヘッダーを無効にする必須設定
      // 署名の鍵は、既定の EdDSA ではなく最も互換性の高い RS256 にする（ALB が EdDSA に対応するかを確認できていないため）
      jwt({
        disableSettingJwtHeader: true,
        jwks: { keyPairConfig: { alg: "RS256" } },
      }),
      oauthProvider({
        loginPage: SIGN_IN_PATH,
        consentPage: CONSENT_PATH,
        scopes: OIDC_SCOPES,
        // クライアントシークレットは SHA-256 のダイジェストで保存する（register-alb-client.ts も同じ方式で書き込む）
        storeClientSecret: "hashed",
      }),
    ],
  };
}

export function createAuth(config: Config, pool: pg.Pool) {
  return betterAuth(createAuthOptions(config, pool));
}

export type Auth = ReturnType<typeof createAuth>;
