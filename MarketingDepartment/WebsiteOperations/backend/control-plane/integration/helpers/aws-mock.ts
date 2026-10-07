// AWS SDK（@aws-sdk/client-s3・@aws-sdk/client-cloudwatch）の差し替え。開発時は AWS に繋がない。
// テストファイルの vi.mock から `() => import("./helpers/aws-mock.js").then((m) => m.s3Module)` の形で使う。
// 送ったコマンドの input を記録し、送信の結果（成功・例外）はテストごとに s3Send / cloudWatchSend の実装で決める。
import { vi } from "vitest";

export interface SentCommand {
  command: string;
  input: Record<string, unknown>;
}

export const aws = {
  s3Send: vi.fn<(command: SentCommand) => Promise<unknown>>(),
  cloudWatchSend: vi.fn<(command: SentCommand) => Promise<unknown>>(),
};

class Command {
  constructor(readonly input: Record<string, unknown>) {}
}
class PutObjectCommand extends Command {
  readonly command = "PutObject";
}
class PutMetricDataCommand extends Command {
  readonly command = "PutMetricData";
}

class S3Client {
  constructor(readonly config: unknown) {}
  send(command: SentCommand): Promise<unknown> {
    return aws.s3Send(command);
  }
}
class CloudWatchClient {
  constructor(readonly config: unknown) {}
  send(command: SentCommand): Promise<unknown> {
    return aws.cloudWatchSend(command);
  }
}

export const s3Module = { S3Client, PutObjectCommand };
export const cloudWatchModule = { CloudWatchClient, PutMetricDataCommand };

/** 既定は成功（PutObject は ETag を返す）。各テストの beforeEach で呼ぶ */
export function resetAws(): void {
  aws.s3Send.mockReset().mockImplementation(async () => ({ ETag: '"it"' }));
  aws.cloudWatchSend.mockReset().mockImplementation(async () => ({}));
}

/** AWS SDK の例外の形（name と $metadata.httpStatusCode） */
export function awsError(name: string, httpStatusCode: number, message = name): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode } });
}

/** 送られた PutObject の input（Key・Body・IfNoneMatch など） */
export function putObjects(): Record<string, unknown>[] {
  return aws.s3Send.mock.calls.map(([command]) => command).filter((c) => c.command === "PutObject").map((c) => c.input);
}
