import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// useRouter は Next.js のアプリのコンテキストが要るので差し替える。フックは react-dom/server で 1 回描いて取り出す
const mocks = vi.hoisted(() => ({
  push: vi.fn((_href: string) => {}),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

import { formatTime, useFollow } from "@/components/common/navigation";

type FollowDetail = { href?: string; external?: boolean };

function renderFollow(): (event: CustomEvent<FollowDetail>) => void {
  let follow: ((event: CustomEvent<FollowDetail>) => void) | undefined;
  function Probe() {
    follow = useFollow();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!follow) throw new Error("useFollow を取り出せなかった");
  return follow;
}

const followEvent = (detail: FollowDetail) => new CustomEvent<FollowDetail>("follow", { detail, cancelable: true });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useFollow", () => {
  describe("正常系", () => {
    it("アプリ内のパスは既定の遷移を止め、Next.js のクライアント遷移にする", () => {
      const event = followEvent({ href: "/runs/new?jobId=daily-seo" });
      renderFollow()(event);
      expect(event.defaultPrevented).toBe(true);
      expect(mocks.push).toHaveBeenCalledWith("/runs/new?jobId=daily-seo");
    });

    it("外部リンク（external=true）はブラウザに任せる", () => {
      const event = followEvent({ href: "/runs", external: true });
      renderFollow()(event);
      expect(event.defaultPrevented).toBe(false);
      expect(mocks.push).not.toHaveBeenCalled();
    });

    it.each(["https://github.com/comegin", "mailto:admin@comegin.com", "runs"])(
      "/ で始まらない href（%s）はブラウザに任せる",
      (href) => {
        const event = followEvent({ href });
        renderFollow()(event);
        expect(event.defaultPrevented).toBe(false);
        expect(mocks.push).not.toHaveBeenCalled();
      },
    );
  });

  describe("異常系", () => {
    it.each([
      ["href が無い", {}],
      ["href が空文字", { href: "" }],
    ])("空入力: %s なら何もしない（既定の動作も止めない）", (_label, detail) => {
      const event = followEvent(detail);
      renderFollow()(event);
      expect(event.defaultPrevented).toBe(false);
      expect(mocks.push).not.toHaveBeenCalled();
    });
  });
});

describe("formatTime", () => {
  describe("正常系", () => {
    it("既定は秒まで「YYYY-MM-DD HH:mm:ss」にし、タイムゾーンの表記を落とす", () => {
      expect(formatTime("2026-10-05T09:05:30+09:00")).toBe("2026-10-05 09:05:30");
    });

    it("minute を指定すると分までにする", () => {
      expect(formatTime("2026-10-05T09:05:30+09:00", "minute")).toBe("2026-10-05 09:05");
    });

    it("ミリ秒付きでも秒までで切る", () => {
      expect(formatTime("2026-10-05T09:05:30.123+09:00")).toBe("2026-10-05 09:05:30");
    });
  });

  describe("異常系", () => {
    it.each([
      ["null", null],
      ["空文字", ""],
    ])("空入力: %s なら「-」を返す", (_label, value) => {
      expect(formatTime(value)).toBe("-");
      expect(formatTime(value, "minute")).toBe("-");
    });

    it("入力: ISO 8601 でない文字列も例外にせず、先頭を切り出すだけにする（検証は control-plane 側）", () => {
      expect(formatTime("not a date")).toBe("not a date");
    });
  });
});
