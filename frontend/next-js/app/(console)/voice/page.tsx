import { VoiceConfigError } from "@/components/voice/VoiceConfigError";
import { VoiceLoader } from "@/components/voice/VoiceLoader";
import { readLiveKitServerConfig } from "@/lib/livekit/server-config";
import { requirePageSession } from "@/lib/session";

// 音声 BI: SEO の BI の担当者（オンプレの LiveKit のエージェント）と声で話す。LiveKit の部品はブラウザだけで描く（VoiceLoader）。
// ブラウザに渡すのはエージェントの名前だけ。SFU の URL とトークンは /api/livekit/token が返す
export default async function VoicePage() {
  await requirePageSession();
  const settings = readLiveKitServerConfig();
  if (!settings.ok) return <VoiceConfigError missing={settings.missing} />;
  return <VoiceLoader agentName={settings.config.agentName} />;
}
