import { createAuth } from "../auth.js";
import { loadAlbConfig, loadConfig } from "../config.js";
import { createPool } from "../db.js";
import { type AuthMethod, registerAlbClient } from "../operations.js";

// ALB の authenticate-oidc を、信頼済みの機密クライアントとして登録（なければ作成、あれば同じ内容に更新）する。
// 何度実行しても同じ結果になる。ALB_CLIENT_ID / ALB_CLIENT_SECRET は ALB のリスナールールと同じ値（本番は同じ Secret）。
// 開発の CLI。本番は運用の Lambda（ops.ts）の {"action":"register-alb-client","authMethod":…,"requirePkce":…}。
//
// 使い方: pnpm alb:register [-- --auth-method=client_secret_basic|client_secret_post] [-- --require-pkce]
//   --auth-method  ALB がトークンエンドポイントで使う認証方式。既定は client_secret_basic。ALB で invalid_client になるときに post へ切り替える
//   --require-pkce ALB が PKCE に対応していると確認できたときだけ付ける（既定は PKCE を必須にしない。README の「実地で未確認の点」）

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
  const { outcome, redirectUris } = await registerAlbClient(createAuth(config, pool), alb, { authMethod, requirePkce });
  console.error(`[alb] ${outcome} client ${alb.ALB_CLIENT_ID}`);
  console.error(`[alb] token_endpoint_auth_method=${authMethod} require_pkce=${requirePkce} skip_consent=true`);
  for (const uri of redirectUris) console.error(`[alb] redirect_uri ${uri}`);
} catch (error) {
  console.error(`[alb] failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
