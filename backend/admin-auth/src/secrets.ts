import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * <prefix>/<name> の Secret を読む関数を返す（Lambda の本体と運用の入口がコールドスタートで使う。仕様 3.6）。
 * 値はログにも例外のメッセージにも出さない（Secret の名前だけ）
 */
export function secretReader(client: Pick<SecretsManagerClient, "send">, prefix: string): (name: string) => Promise<string> {
  return async (name) => {
    if (!prefix) throw new Error("SECRETS_PREFIX が未設定");
    const out = await client.send(new GetSecretValueCommand({ SecretId: `${prefix}/${name}` }));
    if (!out.SecretString) throw new Error(`${prefix}/${name} に値が無い`);
    return out.SecretString;
  };
}
