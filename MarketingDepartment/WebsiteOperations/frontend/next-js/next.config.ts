import path from "node:path";
import type { NextConfig } from "next";

// next-js と backend/control-plane の親（W = MarketingDepartment/WebsiteOperations）。
// Turbopack は root の外のファイルを解決しないため、link: で取り込んだ control-plane を読むには、両方の親を root にする。
const root = path.join(__dirname, "../..");

const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  // control-plane（node:sqlite・Agent SDK・AWS SDK を使う）と Agent SDK はバンドルせず、Node の require に任せる。
  // control-plane は backend/control-plane を link: で取り込み、dist/ を読む（先に control-plane の pnpm build が要る）。
  serverExternalPackages: ["control-plane", "@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
