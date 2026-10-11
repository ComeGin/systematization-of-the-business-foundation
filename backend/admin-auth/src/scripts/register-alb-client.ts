import { createHash } from "node:crypto";
import { createAuth } from "../auth.js";
import { loadAlbConfig, loadConfig } from "../config.js";
import { OIDC_SCOPES } from "../constants.js";
import { createPool } from "../db.js";

// ALB の authenticate-oidc を、信頼済みの機密クライアントとして登録（なければ作成、あれば同じ内容に更新）する。
// 何度実行しても同じ結果になる。ALB_CLIENT_ID / ALB_CLIENT_SECRET は ALB のリスナールールと同じ値（本番は同じ Secret）。
//
// 使い方: pnpm alb:register [-- --auth-method=client_secret_basic|client_secret_post] [-- --require-pkce]
//   --auth-method  ALB がトークンエンドポイントで使う認証方式。既定は client_secret_basic。ALB で invalid_client になるときに post へ切り替える
//   --require-pkce ALB が PKCE に対応していると確認できたときだけ付ける（既定は PKCE を必須にしない。README の「実地で未確認の点」）

type AuthMethod = "client_secret_basic" | "client_secret_post";

function parseArgs(argv: string[]): { authMethod: AuthMethod; requirePkce: boolean } {
  let authMethod: AuthMethod = "client_secret_basic";
  let requirePkce = false;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--require-pkce") requirePkce = true;
    else if (arg === "--auth-method=client_secret_basic" || arg === "--auth-method=client_secret_post") {
      authMethod = arg.slice("--auth-method=".length) as AuthMethod;
    } else {
      console.error(`不明なオプション: ${arg}`);
      process.exit(1);
    }
  }
  return { authMethod, requirePkce };
}

const { authMethod, requirePkce } = parseArgs(process.argv.slice(2));
const config = loadConfig();
const alb = loadAlbConfig();
const pool = createPool(config);

try {
  // 公開 API（adminCreateOAuthClient）はログイン済みのユーザーのセッションを要求するため、
  // 同じアダプターで oauthClient の行を直接書く。client_id と client_secret を指定できるのもこの方法だけ
  const { adapter } = await createAuth(config, pool).$context;
  const now = new Date();
  const redirectUris = alb.ALB_PROTECTED_HOSTS.map((host) => `https://${host}/oauth2/idpresponse`);
  const fields = {
    // plugin の既定（storeClientSecret: "hashed"）と同じ方式: SHA-256 の base64url（パディングなし）
    clientSecret: createHash("sha256").update(alb.ALB_CLIENT_SECRET).digest("base64url"),
    name: "ALB (admin gate)",
    redirectUris,
    scopes: OIDC_SCOPES,
    tokenEndpointAuthMethod: authMethod,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    applicationType: "web",
    // 自社の管理画面に、毎回「許可しますか」と聞かない
    skipConsent: true,
    enableEndSession: false,
    requirePKCE: requirePkce,
    disabled: false,
    clientCredentialsScopes: [],
    updatedAt: now,
  };

  const where = [{ field: "clientId", value: alb.ALB_CLIENT_ID }];
  const existing = await adapter.findOne<Record<string, unknown>>({ model: "oauthClient", where });
  // 同じ内容なら何も書かない（updatedAt も変えない）
  const { updatedAt: _updatedAt, ...desired } = fields;
  const unchanged =
    existing !== null && Object.entries(desired).every(([key, value]) => JSON.stringify(existing[key]) === JSON.stringify(value));
  if (!unchanged) {
    if (existing) {
      await adapter.update({ model: "oauthClient", where, update: fields });
    } else {
      await adapter.create({
        model: "oauthClient",
        data: { clientId: alb.ALB_CLIENT_ID, clientDiscoveryId: null, createdAt: now, ...fields },
      });
    }
  }

  console.error(`[alb] ${unchanged ? "unchanged" : existing ? "updated" : "created"} client ${alb.ALB_CLIENT_ID}`);
  console.error(`[alb] token_endpoint_auth_method=${authMethod} require_pkce=${requirePkce} skip_consent=true`);
  for (const uri of redirectUris) console.error(`[alb] redirect_uri ${uri}`);
} catch (error) {
  console.error(`[alb] failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
