"use client";

// @livekit/components-styles は /voice の部品からだけ読み込む。セレクタはすべて .lk-*・[data-lk-theme] に閉じている
// （2026-11-21 に 1.2.0 の index.css で確認）ので、Next.js が画面遷移で外さなくても Cloudscape の部品には効かない
import "@livekit/components-styles";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { RoomAudioRenderer, SessionProvider, useSession } from "@livekit/components-react";
import { ConnectionError, ConnectionErrorReason, ConnectionState, Room, TokenSource } from "livekit-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AgentPanel } from "./AgentPanel";
import { BiCardList } from "./BiCardList";
import { MediaControls } from "./MediaControls";
import { TranscriptPanel } from "./TranscriptPanel";

/** トークンの API（app/api/livekit/token/route.ts）。同じオリジンなのでセッションの Cookie がそのまま付く */
const TOKEN_ENDPOINT = "/api/livekit/token";

/** SFU に届かないときの案内（D8f。起動と停止は人が手で行う） */
const SFU_DOWN_MESSAGE = "SFU が停止中かもしれません（node cloud/livekit-sfu.mjs start）。開発では backend/livekit-system の docker compose up -d を確かめてください。";

/** 開始に失敗した理由を、利用者が次に何をすればよいか分かる文にする。秘密の値は含めない */
function describeStartError(error: unknown): string {
  if (error instanceof ConnectionError) {
    switch (error.reason) {
      case ConnectionErrorReason.ServerUnreachable:
      case ConnectionErrorReason.WebSocket:
      case ConnectionErrorReason.Timeout:
      case ConnectionErrorReason.InternalError:
        return SFU_DOWN_MESSAGE;
      case ConnectionErrorReason.NotAllowed:
        return "SFU が接続を拒否しました（トークンの鍵が SFU の設定と合っていない可能性があります）。";
      case ConnectionErrorReason.Cancelled:
        return "接続を取りやめました。";
      default:
        return `SFU に接続できませんでした（${error.message}）。${SFU_DOWN_MESSAGE}`;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  // TokenSource.endpoint は失敗時に「Error generating token from endpoint … received <status> / <本文>」を投げる
  if (message.includes("Error generating token")) {
    const status = /received (\d{3})/.exec(message)?.[1];
    if (status === "401") return "ログインが切れました。ページを読み込み直してください。";
    if (status === "500") return "トークンを発行できませんでした（監視アプリの LiveKit の環境変数を確かめてください）。";
    return `トークンを発行できませんでした（HTTP ${status ?? "不明"}）。`;
  }
  if (/agent/i.test(message)) return "エージェントが部屋に入りませんでした（オンプレのエージェントが動いているか確かめてください）。";
  return `接続に失敗しました（${message}）。`;
}

/**
 * 音声 BI のセッション（U7。LiveKit Components React）。
 * 開始は利用者の「開始」のボタンで行う（自動では始めない）。マイクの取り込みは、エコー除去だけをブラウザで行い、
 * 雑音の抑制と音量の自動調整はエージェント側（WebRTC の APM）に任せる（U3。二重にかけない）。
 */
export function VoiceSession({ agentName }: { agentName: string }) {
  const [room] = useState(
    () =>
      new Room({
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
        adaptiveStream: true,
        dynacast: true,
      }),
  );
  const tokenSource = useMemo(() => TokenSource.endpoint(TOKEN_ENDPOINT), []);
  // useSession は画面を開いた時点でトークンを 1 つ発行し、SFU への予備接続（prepareConnection）をする。
  // 部屋は作らない（部屋ができてエージェントが呼ばれるのは「開始」で接続したとき）。終了のたびに、次の部屋のトークンを先に取り直す
  const session = useSession(tokenSource, { room, agentName });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 「開始」のたびに増やす。会話とカードの部品をこの値で作り直し、前のセッションの分を画面から消す
  const [generation, setGeneration] = useState(0);
  // 開始の途中で「終了」したときに接続を取りやめる
  const abortRef = useRef<AbortController | null>(null);

  // 画面を離れたら切断する（エージェントのセッションも終わる）
  useEffect(() => () => void room.disconnect(), [room]);

  const connected = session.connectionState !== ConnectionState.Disconnected;

  async function start() {
    const controller = new AbortController();
    abortRef.current = controller;
    // 接続より先に、会話とカードの部品を作り直して受信の準備をそろえる（届いた発話・カードを取りこぼさない）
    flushSync(() => {
      setError(null);
      setStarting(true);
      setGeneration((g) => g + 1);
    });
    try {
      await session.start({ signal: controller.signal });
    } catch (e) {
      // 利用者が取りやめたときは失敗として出さない
      if (!controller.signal.aborted) setError(describeStartError(e));
      await session.end().catch(() => undefined);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStarting(false);
    }
  }

  async function end() {
    setError(null);
    abortRef.current?.abort(); // 開始の途中なら取りやめる（useSession が部屋を切る）
    await session.end().catch(() => undefined);
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="接続すると、エージェントが GSC・GA4 の要点を話します。そのあとは声かチャットで質問できます。画面共有を始めると、画面について聞けます（聞いたときだけ、その時点の 1 枚を読み取ります）。"
          actions={
            connected || starting ? (
              <Button onClick={() => void end()}>{starting ? "取りやめる" : "終了"}</Button>
            ) : (
              <Button variant="primary" onClick={() => void start()} loading={starting}>
                開始
              </Button>
            )
          }
        >
          音声 BI
        </Header>
      }
    >
      <SessionProvider session={session}>
        <SpaceBetween size="l">
          {error ? (
            <Alert type="error" header="開始できませんでした" dismissible onDismiss={() => setError(null)}>
              {error}
            </Alert>
          ) : null}
          <Alert type="info">
            音声と、質問したときの画面の 1 枚は OpenAI（米国）に送られます。録音・録画はしません。会話の問いと結論（数値は結果の ID）だけが E-12 に残ります。
          </Alert>
          <ConnectionStatus state={session.connectionState} />
          <ColumnLayout columns={2}>
            <SpaceBetween size="l">
              <Container header={<Header variant="h2">エージェント</Header>}>
                <AgentPanel />
              </Container>
              <Container header={<Header variant="h2">マイク・カメラ・画面共有</Header>}>
                <MediaControls disabled={!session.isConnected} />
              </Container>
            </SpaceBetween>
            <TranscriptPanel key={generation} disabled={!session.isConnected} />
          </ColumnLayout>
          <BiCardList key={generation} />
        </SpaceBetween>
        <RoomAudioRenderer />
      </SessionProvider>
    </ContentLayout>
  );
}

function ConnectionStatus({ state }: { state: ConnectionState }) {
  switch (state) {
    case ConnectionState.Connected:
      return <StatusIndicator type="success">接続中</StatusIndicator>;
    case ConnectionState.Connecting:
      return <StatusIndicator type="in-progress">接続しています</StatusIndicator>;
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return <StatusIndicator type="pending">つなぎ直しています</StatusIndicator>;
    default:
      return (
        <Box color="text-status-inactive">
          <StatusIndicator type="stopped">未接続（「開始」で接続します）</StatusIndicator>
        </Box>
      );
  }
}
