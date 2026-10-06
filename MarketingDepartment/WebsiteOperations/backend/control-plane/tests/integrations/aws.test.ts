import { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { describe, expect, it, vi } from "vitest";
import { classifyAwsError, createS3Client, putHeartbeat } from "../../src/integrations/aws.js";

const fromIniMock = vi.hoisted(() => vi.fn(() => async () => ({ accessKeyId: "x", secretAccessKey: "y" })));
vi.mock("@aws-sdk/credential-providers", () => ({ fromIni: fromIniMock }));

const aws = { region: "ap-northeast-1", profile: null, runlogBucket: "runlog", heartbeatNamespace: "ComeGin/Onprem" };

describe("classifyAwsError", () => {
  it.each([
    [{ name: "TimeoutError" }, "timeout"],
    [{ name: "AbortError" }, "timeout"],
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ code: "ENOTFOUND" }, "unreachable"],
    [{ code: "ECONNREFUSED" }, "unreachable"],
    [{ code: "ECONNRESET" }, "unreachable"],
    [{ code: "EAI_AGAIN" }, "unreachable"],
    [{ code: "EHOSTUNREACH" }, "unreachable"],
    [{ $metadata: { httpStatusCode: 401 } }, "auth_failed"],
    [{ name: "CredentialsProviderError" }, "auth_failed"],
    [{ name: "ExpiredToken", $metadata: { httpStatusCode: 400 } }, "auth_failed"],
    [{ name: "InvalidAccessKeyId", $metadata: { httpStatusCode: 403 } }, "auth_failed"],
    [{ name: "SignatureDoesNotMatch", $metadata: { httpStatusCode: 403 } }, "auth_failed"],
    [{ $metadata: { httpStatusCode: 403 } }, "permission_denied"],
    [{ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }, "permission_denied"],
    [{ name: "AccessDeniedException" }, "permission_denied"],
    [{ $metadata: { httpStatusCode: 429 } }, "rate_limited"],
    [{ name: "SlowDown", $metadata: { httpStatusCode: 503 } }, "rate_limited"],
    [{ name: "ThrottlingException", $metadata: { httpStatusCode: 400 } }, "rate_limited"],
    [{ name: "InternalError", $metadata: { httpStatusCode: 500 } }, "invalid_response"],
    [{ name: "Unknown" }, "unreachable"],
  ])("%o は %s", (error, failureClass) => {
    expect(classifyAwsError(error)).toBe(failureClass);
  });

  it("null・undefined でも落ちずに unreachable", () => {
    expect(classifyAwsError(null)).toBe("unreachable");
    expect(classifyAwsError(undefined)).toBe("unreachable");
  });

  it("タイムアウトは HTTP ステータスより先に判定する", () => {
    expect(classifyAwsError({ name: "TimeoutError", $metadata: { httpStatusCode: 403 } })).toBe("timeout");
  });
});

describe("createS3Client", () => {
  it("AWS_PROFILE があるときだけ fromIni でそのプロファイルを使う", () => {
    createS3Client(aws);
    expect(fromIniMock).not.toHaveBeenCalled();
    createS3Client({ ...aws, profile: "comegin-onprem" });
    expect(fromIniMock).toHaveBeenCalledWith({ profile: "comegin-onprem" });
  });
});

describe("putHeartbeat", () => {
  it("HEARTBEAT_NAMESPACE に Heartbeat=1（Count）を送る", async () => {
    const send = vi.fn(async () => ({}));
    await putHeartbeat({ send } as never, aws);
    const [command, options] = send.mock.calls[0] as unknown as [PutMetricDataCommand, { abortSignal: AbortSignal }];
    expect(command).toBeInstanceOf(PutMetricDataCommand);
    expect(command.input.Namespace).toBe("ComeGin/Onprem");
    expect(command.input.MetricData).toEqual([
      expect.objectContaining({ MetricName: "Heartbeat", Value: 1, Unit: "Count", Timestamp: expect.any(Date) }),
    ]);
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("タイムアウトは 10 秒で、外からの打ち切りも効く", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const send = vi.fn(async () => ({}));
    const stop = new AbortController();
    await putHeartbeat({ send } as never, aws, stop.signal);
    expect(timeout).toHaveBeenCalledWith(10_000);
    const { abortSignal } = (send.mock.calls[0] as unknown as [unknown, { abortSignal: AbortSignal }])[1];
    expect(abortSignal.aborted).toBe(false);
    stop.abort();
    expect(abortSignal.aborted).toBe(true);
  });

  it("送信の失敗はそのまま投げる（分類は呼び出し側）", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("denied"), { name: "AccessDenied" });
    });
    await expect(putHeartbeat({ send } as never, aws)).rejects.toThrow("denied");
  });
});
