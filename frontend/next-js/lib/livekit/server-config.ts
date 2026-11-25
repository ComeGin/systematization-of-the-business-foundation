// LiveKit（音声 BI の SFU）への接続の設定。サーバー側（Route Handler・Server Component）だけで読む。
// API キーとシークレットはブラウザに渡さない。ブラウザに出してよいのは server_url（wss）とエージェントの名前だけ。
// server-only は Next.js が解決する（依存に入れるのは任意。node_modules/next/dist/docs の「Preventing environment poisoning」）。
// Client Component から import するとビルドで失敗する
import "server-only";

/** 必須の環境変数（.env.example の「音声 BI」の節） */
export const LIVEKIT_REQUIRED_ENV_NAMES = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const;

/** LIVEKIT_AGENT_NAME の既定（エージェントの既定と同じ。backend/livekit-agent の config/settings.py） */
export const DEFAULT_LIVEKIT_AGENT_NAME = "comegin-seo-bi";

export interface LiveKitServerConfig {
  /** ブラウザが接続する SFU の URL（wss://… 。開発は ws://127.0.0.1:7880） */
  serverUrl: string;
  apiKey: string;
  apiSecret: string;
  /** dispatch するエージェントの名前（エージェントの rtc_session(agent_name=…) と同じ。空なら既定） */
  agentName: string;
}

export type LiveKitServerConfigResult = { ok: true; config: LiveKitServerConfig } | { ok: false; missing: string[] };

/** 環境変数を読む。足りないときは変数名だけを返す（値は返さない・出さない） */
export function readLiveKitServerConfig(): LiveKitServerConfigResult {
  const read = (name: string) => process.env[name]?.trim() ?? "";
  const missing = LIVEKIT_REQUIRED_ENV_NAMES.filter((name) => !read(name));
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      serverUrl: read("LIVEKIT_URL"),
      apiKey: read("LIVEKIT_API_KEY"),
      apiSecret: read("LIVEKIT_API_SECRET"),
      agentName: read("LIVEKIT_AGENT_NAME") || DEFAULT_LIVEKIT_AGENT_NAME,
    },
  };
}
