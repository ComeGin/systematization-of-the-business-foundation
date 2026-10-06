import { describe, expect, it, vi } from "vitest";
import type { BuiltinInput } from "../../src/context.js";
import type { RunLogCopier } from "../../src/integrations/runlog.js";
import { heartbeat, publishedArticleCheck, runlogFlush } from "../../src/builtin/simple.js";
import { makeConfig, makeCtx } from "../helpers/runner.js";

const awsMock = vi.hoisted(() => ({
  createCloudWatchClient: vi.fn(() => ({ send: vi.fn() })),
  putHeartbeat: vi.fn(async () => undefined),
}));
vi.mock("../../src/integrations/aws.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/integrations/aws.js")>()),
  createCloudWatchClient: awsMock.createCloudWatchClient,
  putHeartbeat: awsMock.putHeartbeat,
}));

const aws = { region: "ap-northeast-1", profile: null, runlogBucket: "b", heartbeatNamespace: "ComeGin/Onprem" };

function input(ctx: BuiltinInput["ctx"]): BuiltinInput {
  return { ctx, runId: "01K6PZ3T8Q4M2N7R9S5V1W3X6Y", signal: new AbortController().signal, timeoutSec: 60, job: null };
}

describe("heartbeat", () => {
  it("AWS の設定が無ければ例外（エンジンが先に見送るため、ここに来るのは誤り）", async () => {
    await expect(heartbeat(input(makeCtx(makeConfig())))).rejects.toThrow("AWS の設定が無い");
  });

  it("送れたら success", async () => {
    const result = await heartbeat(input(makeCtx(makeConfig({ aws }))));
    expect(result).toEqual({ outcome: "success", summary: "ハートビートを送信した", targetIds: [] });
    expect(awsMock.putHeartbeat).toHaveBeenCalledWith(expect.anything(), aws, expect.any(AbortSignal));
  });

  it("失敗は AWS の例外を分類して failure にする", async () => {
    awsMock.putHeartbeat.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "ThrottlingException" }));
    const result = await heartbeat(input(makeCtx(makeConfig({ aws }))));
    expect(result).toMatchObject({ outcome: "failure", failureClass: "rate_limited" });
  });
});

describe("runlogFlush", () => {
  const withCopier = (flushResult: Awaited<ReturnType<RunLogCopier["flush"]>>) =>
    makeCtx(makeConfig({ aws }), { copier: { flush: vi.fn(async () => flushResult) } as unknown as RunLogCopier });

  it("copier が無ければ例外", async () => {
    await expect(runlogFlush(input(makeCtx(makeConfig())))).rejects.toThrow("AWS の設定が無い");
  });

  it("失敗が無ければ success で、件数を要約に書く", async () => {
    const result = await runlogFlush(input(withCopier({ sent: 3, alreadyCopied: 1, remaining: 0, failureClass: null })));
    expect(result).toEqual({ outcome: "success", summary: "S3 への写し: 送信 3 件（写し済み 1 件）", targetIds: [] });
  });

  it("一部でも送れていれば partial、1 件も送れなければ failure", async () => {
    const partial = await runlogFlush(
      input(withCopier({ sent: 0, alreadyCopied: 1, remaining: 2, failureClass: "permission_denied" })),
    );
    expect(partial).toMatchObject({ outcome: "partial", failureClass: "permission_denied" });
    const failure = await runlogFlush(input(withCopier({ sent: 0, alreadyCopied: 0, remaining: 2, failureClass: "unreachable" })));
    expect(failure).toMatchObject({ outcome: "failure", failureClass: "unreachable", summary: "S3 への写し: 送信 0 件、残り 2 件" });
  });

  it("打ち切りの signal を copier に渡す", async () => {
    const ctx = withCopier({ sent: 0, alreadyCopied: 0, remaining: 0, failureClass: null });
    const args = input(ctx);
    await runlogFlush(args);
    expect(ctx.copier!.flush).toHaveBeenCalledWith(args.signal);
  });
});

describe("publishedArticleCheck", () => {
  it("未実装のため skipped（理由つき）を返す", async () => {
    const result = await publishedArticleCheck(input(makeCtx(makeConfig())));
    expect(result.outcome).toBe("skipped");
    expect(result.skipReason).toContain("未実装");
  });
});
