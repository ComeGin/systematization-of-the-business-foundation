// 写し（S3）とハートビート（CloudWatch）。使う資格情報は監視アプリのサーバー側だけにあり、エージェントには渡らない。
// AWS SDK の再試行（既定 3 回）はそのまま使う。DD-01 の再試行の表は HTTP を直接呼ぶ連携（fetchJson）に適用する。
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import type { ControlPlaneConfig } from "../config.js";
import type { FailureClass } from "../contract.js";
import { CONTROL_TIMEOUT_SEC } from "../constants/timeouts.js";

type AwsConfig = NonNullable<ControlPlaneConfig["aws"]>;

function credentials(aws: AwsConfig) {
  return aws.profile ? fromIni({ profile: aws.profile }) : undefined;
}

export function createS3Client(aws: AwsConfig): S3Client {
  return new S3Client({ region: aws.region, credentials: credentials(aws) });
}

export function createCloudWatchClient(aws: AwsConfig): CloudWatchClient {
  return new CloudWatchClient({ region: aws.region, credentials: credentials(aws) });
}

interface AwsErrorShape {
  name?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
}

/** AWS SDK の例外を、失敗分類 9 値のどれかに当てはめる。 */
export function classifyAwsError(error: unknown): FailureClass {
  const e = (error ?? {}) as AwsErrorShape;
  const status = e.$metadata?.httpStatusCode;
  const name = e.name ?? "";
  const code = e.code ?? "";
  if (name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT") return "timeout";
  if (["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "EHOSTUNREACH"].includes(code)) return "unreachable";
  if (
    status === 401 ||
    [
      "CredentialsProviderError",
      "ExpiredToken",
      "ExpiredTokenException",
      "InvalidClientTokenId",
      "UnrecognizedClientException",
      "InvalidAccessKeyId",
      "SignatureDoesNotMatch",
    ].includes(name)
  ) {
    return "auth_failed";
  }
  if (status === 403 || name === "AccessDenied" || name === "AccessDeniedException") return "permission_denied";
  if (status === 429 || ["ThrottlingException", "SlowDown", "Throttling"].includes(name)) return "rate_limited";
  if (status === undefined) return "unreachable";
  return "invalid_response";
}

/** ハートビート（CloudWatch のカスタムメトリクス Heartbeat=1）を 1 回送る。 */
export async function putHeartbeat(client: CloudWatchClient, aws: AwsConfig, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(CONTROL_TIMEOUT_SEC.cloudwatchPut * 1000);
  await client.send(
    new PutMetricDataCommand({
      Namespace: aws.heartbeatNamespace,
      MetricData: [{ MetricName: "Heartbeat", Value: 1, Unit: "Count", Timestamp: new Date() }],
    }),
    { abortSignal: signal ? AbortSignal.any([timeout, signal]) : timeout },
  );
}
