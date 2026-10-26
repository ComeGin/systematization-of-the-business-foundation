import path from "node:path";
import type { NextConfig } from "next";

// next-js と backend/control-plane の共通の親（リポジトリのルート）。
// Turbopack は root の外のファイルを解決しないため、link: で取り込んだ control-plane を読むには、両方の親を root にする。
const root = path.join(__dirname, "../..");

// 開発で ngrok から開く（ADR-23）とき、開発サーバーの資源（/_next/hmr など）は既定で別オリジンから拒否される。
// BETTER_AUTH_URL（.env。Next.js は next.config より先に読み込む）のホストが 127.0.0.1・localhost 以外なら、そのホストだけを許す
function tunnelHosts(): string[] {
  try {
    const host = new URL(process.env.BETTER_AUTH_URL ?? "").hostname;
    return host && host !== "127.0.0.1" && host !== "localhost" ? [host] : [];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  // control-plane（node:sqlite・Agent SDK・AWS SDK を使う）と Agent SDK はバンドルせず、Node の require に任せる。
  // control-plane は backend/control-plane を link: で取り込み、dist/ を読む（先に control-plane の pnpm build が要る）。
  serverExternalPackages: ["control-plane", "@anthropic-ai/claude-agent-sdk"],
  allowedDevOrigins: tunnelHosts(),
  // E2E 専用のインスタンス（3201。playwright.config.mts）は出力先を分ける。next dev は distDir の下でロックを取るため、
  // 同じ .next では開発のインスタンス（3200）と並べて起動できない。型の置き場は tsconfig.json の include に書いてある
  ...(process.env.COMEGIN_NEXT_DIST_DIR?.trim() ? { distDir: process.env.COMEGIN_NEXT_DIST_DIR.trim() } : {}),
};

export default nextConfig;
