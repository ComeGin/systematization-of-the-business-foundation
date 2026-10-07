// admin-auth の PostgreSQL（ホストに公開していない）を、コンテナの中の psql で読む・後片付けする。
// 接続の資格情報はコンテナの環境変数（POSTGRES_USER・POSTGRES_DB）のまま使い、外に出さない。
// 値は psql の変数（:'v1'）で渡す（SQL に文字列を埋め込まない。-c は変数を展開しないので標準入力で渡す）。
import { execIn } from "../helpers/docker.ts";
import { CONTAINERS } from "../helpers/services.ts";

const ADMIN_AUTH_CONTAINER = "admin-auth-admin-auth-1";

/** admin-auth のコンテナの、秘密でない環境変数を 1 つだけ読む。未設定なら空文字 */
export async function adminAuthEnv(name: "BETTER_AUTH_URL" | "GOOGLE_HOSTED_DOMAIN"): Promise<string> {
  try {
    return await execIn(ADMIN_AUTH_CONTAINER, ["printenv", name]);
  } catch {
    return "";
  }
}

/** Google の資格情報が入っているか（値は読まない） */
export async function googleConfigured(): Promise<boolean> {
  try {
    await execIn(ADMIN_AUTH_CONTAINER, ["sh", "-c", 'test -n "$GOOGLE_CLIENT_ID" && test -n "$GOOGLE_CLIENT_SECRET"']);
    return true;
  } catch {
    return false;
  }
}

/** 1 列目だけを行ごとに返す（psql -At） */
export async function psql(sql: string, ...values: string[]): Promise<string[]> {
  const vars = values.flatMap((v, i) => ["-v", `v${i + 1}=${v}`]);
  const out = await execIn(CONTAINERS.adminAuthPostgres, [
    "sh",
    "-c",
    'sql="$1"; shift; printf "%s\\n" "$sql" | psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -q -v ON_ERROR_STOP=1 "$@"',
    "sh",
    sql,
    ...vars,
  ]);
  return out.split("\n").filter(Boolean);
}

/** 登録済みの OAuth クライアントを 1 つ（ALB の登録スクリプトが作るもの）。無ければ undefined */
export async function registeredClient(): Promise<{ clientId: string; redirectUri: string } | undefined> {
  const rows = await psql(`SELECT "clientId" || ' ' || ("redirectUris"::jsonb ->> 0) FROM "oauthClient" WHERE "redirectUris" IS NOT NULL ORDER BY "createdAt" LIMIT 1;`);
  const [clientId, redirectUri] = (rows[0] ?? "").split(" ");
  return clientId && redirectUri ? { clientId, redirectUri } : undefined;
}

/** ソーシャルログインの開始で作られた state の行を消す（10 分で期限が切れるが、テストの後に残さない） */
export async function deleteVerification(identifier: string): Promise<void> {
  await psql(`DELETE FROM verification WHERE identifier = :'v1';`, identifier);
}

export async function countUsersByEmail(email: string): Promise<number> {
  const [count] = await psql(`SELECT count(*) FROM "user" WHERE lower(email) = lower(:'v1');`, email);
  return Number(count);
}
