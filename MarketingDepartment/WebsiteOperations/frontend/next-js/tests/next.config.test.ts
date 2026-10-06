import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const NEXT_JS_DIR = fileURLToPath(new URL("..", import.meta.url));

// next.config は読み込み時に BETTER_AUTH_URL を読むので、毎回読み直す
async function loadConfig(betterAuthUrl: string | undefined) {
  vi.resetModules();
  vi.stubEnv("BETTER_AUTH_URL", betterAuthUrl);
  return (await import("@/next.config")).default;
}

describe("allowedDevOrigins（ngrok から開くときの開発サーバーの許可）", () => {
  it("BETTER_AUTH_URL が ngrok の URL なら、そのホストだけを許す", async () => {
    const config = await loadConfig("https://comegin-next-js-dev.ngrok.app");
    expect(config.allowedDevOrigins).toEqual(["comegin-next-js-dev.ngrok.app"]);
  });

  it.each(["http://127.0.0.1:3200", "http://localhost:3200"])("%s なら何も許さない（ループバックは既定で通る）", async (url) => {
    const config = await loadConfig(url);
    expect(config.allowedDevOrigins).toEqual([]);
  });

  it.each([
    ["未設定", undefined],
    ["URL として読めない", "comegin-next-js-dev.ngrok.app"],
  ])("BETTER_AUTH_URL が %s なら何も許さず、例外も投げない", async (_label, url) => {
    const config = await loadConfig(url);
    expect(config.allowedDevOrigins).toEqual([]);
  });
});

describe("Turbopack の root", () => {
  it("link: で取り込んだ backend/control-plane を含む親（W）を root にする", async () => {
    const config = await loadConfig(undefined);
    const root = config.turbopack?.root;
    expect(root).toBeDefined();
    const controlPlaneDir = path.resolve(NEXT_JS_DIR, "../../backend/control-plane");
    expect(path.relative(root!, controlPlaneDir).startsWith("..")).toBe(false);
    expect(path.relative(root!, NEXT_JS_DIR).startsWith("..")).toBe(false);
    expect(config.outputFileTracingRoot).toBe(root);
  });

  it("control-plane はバンドルせず Node の require に任せる", async () => {
    const config = await loadConfig(undefined);
    expect(config.serverExternalPackages).toContain("control-plane");
  });
});
