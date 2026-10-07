import { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { describe, expect, it, vi } from "vitest";
import { classifyAwsError, createCloudWatchClient, createS3Client, putHeartbeat } from "../../src/integrations/aws.js";

// 資格情報の読み込み（~/.aws を読む）は差し替える。送信は各テストの偽の send だけで、実 AWS には繋がない
const fromIniMock = vi.hoisted(() => vi.fn(() => async () => ({ accessKeyId: "x", secretAccessKey: "y" })));
vi.mock("@aws-sdk/credential-providers", () => ({ fromIni: fromIniMock }));

const aws = { region: "ap-northeast-1", profile: null, runlogBucket: "runlog", heartbeatNamespace: "ComeGin/Onprem" };

describe("classifyAwsError", () => {
  describe("正常系", () => {
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
      [{ name: "ExpiredTokenException", $metadata: { httpStatusCode: 400 } }, "auth_failed"],
      [{ name: "InvalidClientTokenId", $metadata: { httpStatusCode: 403 } }, "auth_failed"],
      [{ name: "UnrecognizedClientException", $metadata: { httpStatusCode: 400 } }, "auth_failed"],
      [{ name: "InvalidAccessKeyId", $metadata: { httpStatusCode: 403 } }, "auth_failed"],
      [{ name: "SignatureDoesNotMatch", $metadata: { httpStatusCode: 403 } }, "auth_failed"],
      [{ $metadata: { httpStatusCode: 403 } }, "permission_denied"],
      [{ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }, "permission_denied"],
      [{ name: "AccessDeniedException" }, "permission_denied"],
      [{ $metadata: { httpStatusCode: 429 } }, "rate_limited"],
      [{ name: "SlowDown", $metadata: { httpStatusCode: 503 } }, "rate_limited"],
      [{ name: "ThrottlingException", $metadata: { httpStatusCode: 400 } }, "rate_limited"],
      [{ name: "Throttling", $metadata: { httpStatusCode: 400 } }, "rate_limited"],
      [{ name: "InternalError", $metadata: { httpStatusCode: 500 } }, "invalid_response"],
      [{ name: "Unknown" }, "unreachable"],
    ])("%o は %s", (error, failureClass) => {
      expect(classifyAwsError(error)).toBe(failureClass);
    });

    it("タイムアウトは HTTP ステータスより先に判定する", () => {
      expect(classifyAwsError({ name: "TimeoutError", $metadata: { httpStatusCode: 403 } })).toBe("timeout");
    });

    it("SDK の実際の例外クラス（Error に name と $metadata が付いたもの）も同じに分類する", () => {
      const error = Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      expect(classifyAwsError(error)).toBe("permission_denied");
    });
  });

  describe("異常系", () => {
    it("空入力: null・undefined でも落ちずに unreachable", () => {
      expect(classifyAwsError(null)).toBe("unreachable");
      expect(classifyAwsError(undefined)).toBe("unreachable");
    });

    it("空入力: 空のオブジェクト（name も code も $metadata も無い）は unreachable", () => {
      expect(classifyAwsError({})).toBe("unreachable");
    });

    it("入力: 文字列・数値など、オブジェクトでない例外でも落ちずに unreachable", () => {
      expect(classifyAwsError("boom")).toBe("unreachable");
      expect(classifyAwsError(42)).toBe("unreachable");
    });

    it("入力: $metadata の形が崩れていても落ちない（httpStatusCode が無ければ unreachable）", () => {
      expect(classifyAwsError({ $metadata: {} })).toBe("unreachable");
      expect(classifyAwsError({ $metadata: null })).toBe("unreachable");
    });
  });
});

describe("createS3Client", () => {
  describe("正常系", () => {
    it("AWS_PROFILE があるときだけ fromIni でそのプロファイルを使う", () => {
      fromIniMock.mockClear();
      createS3Client(aws);
      expect(fromIniMock).not.toHaveBeenCalled();
      createS3Client({ ...aws, profile: "comegin-onprem" });
      expect(fromIniMock).toHaveBeenCalledWith({ profile: "comegin-onprem" });
    });

    it("設定のリージョンを使う", async () => {
      expect(await createS3Client(aws).config.region()).toBe("ap-northeast-1");
    });

    it("空入力: プロファイルが空文字なら fromIni を使わない（既定の資格情報の連鎖に任せる）", () => {
      fromIniMock.mockClear();
      createS3Client({ ...aws, profile: "" });
      expect(fromIniMock).not.toHaveBeenCalled();
    });
  });
});

describe("createCloudWatchClient", () => {
  describe("正常系", () => {
    it("S3 と同じく、プロファイルがあるときだけ fromIni を使い、設定のリージョンを使う", async () => {
      fromIniMock.mockClear();
      const client = createCloudWatchClient(aws);
      expect(fromIniMock).not.toHaveBeenCalled();
      expect(await client.config.region()).toBe("ap-northeast-1");
      createCloudWatchClient({ ...aws, profile: "comegin-onprem" });
      expect(fromIniMock).toHaveBeenCalledWith({ profile: "comegin-onprem" });
    });
  });
});

describe("putHeartbeat", () => {
  describe("正常系", () => {
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

    it("空入力: signal を省くとタイムアウトの signal だけを渡す", async () => {
      const controller = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      const send = vi.fn(async () => ({}));
      await putHeartbeat({ send } as never, aws);
      const { abortSignal } = (send.mock.calls[0] as unknown as [unknown, { abortSignal: AbortSignal }])[1];
      expect(abortSignal).toBe(controller.signal);
    });
  });

  describe("異常系", () => {
    it("サーバ: 送信の失敗はそのまま投げる（分類は呼び出し側）", async () => {
      const send = vi.fn(async () => {
        throw Object.assign(new Error("denied"), { name: "AccessDenied" });
      });
      await expect(putHeartbeat({ send } as never, aws)).rejects.toThrow("denied");
    });

    it("サーバ: タイムアウト（TimeoutError）も投げ、呼び出し側の分類では timeout になる", async () => {
      const send = vi.fn(async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      });
      const error = await putHeartbeat({ send } as never, aws).catch((e: unknown) => e);
      expect(classifyAwsError(error)).toBe("timeout");
    });

    it("サーバ: 接続できない（ECONNREFUSED）も投げ、呼び出し側の分類では unreachable になる", async () => {
      const send = vi.fn(async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      });
      const error = await putHeartbeat({ send } as never, aws).catch((e: unknown) => e);
      expect(classifyAwsError(error)).toBe("unreachable");
    });
  });
});
