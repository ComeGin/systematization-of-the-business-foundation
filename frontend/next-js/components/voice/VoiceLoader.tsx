"use client";

import Spinner from "@cloudscape-design/components/spinner";
import dynamic from "next/dynamic";

// LiveKit の部品（livekit-client の Room・WebRTC）はブラウザの API を使うので、サーバーでは描かない。
// ssr: false は Server Component では使えないため、この Client Component で包む
const VoiceSession = dynamic(() => import("./VoiceSession").then((m) => m.VoiceSession), {
  ssr: false,
  loading: () => <Spinner size="large" />,
});

export function VoiceLoader({ agentName }: { agentName: string }) {
  return <VoiceSession agentName={agentName} />;
}
