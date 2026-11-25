"use client";

import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { type ReceivedMessage, useSessionMessages } from "@livekit/components-react";
import { useEffect, useRef, useState } from "react";

/** 1 回に送れる文字数（エージェントの指示を長文で上書きされないように） */
const MAX_CHAT_CHARS = 500;

/** 文字起こしの確定の印（LiveKit の text stream の属性） */
const TRANSCRIPTION_FINAL = "lk.transcription_final";

/** 見た目には出さず、支援技術にだけ読ませる（JIS の a11y の方針の VisuallyHidden と同じ考え方） */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** 確定した発話か。文字起こしは確定の印が立ったものだけ、チャットは届いた時点で確定 */
function isFinal(message: ReceivedMessage): boolean {
  if (message.type === "agentTranscript" || message.type === "userTranscript") return message.attributes?.[TRANSCRIPTION_FINAL] === "true";
  return true;
}

function speakerOf(message: ReceivedMessage): { label: string; mine: boolean } {
  switch (message.type) {
    case "agentTranscript":
      return { label: "エージェント", mine: false };
    case "userTranscript":
      return { label: "あなた（声）", mine: true };
    default:
      return message.from?.isLocal ? { label: "あなた（チャット）", mine: true } : { label: "エージェント（チャット）", mine: false };
  }
}

/**
 * 文字起こし（ユーザーとエージェントの両方）と、チャット欄（topic lk.chat）。
 * チャットはエージェントの既定のテキスト入力に届き、GPT-Live には commentary として渡る（spec の 4 節 (b)）。
 */
export function TranscriptPanel({ disabled }: { disabled: boolean }) {
  const { messages, send, isSending } = useSessionMessages();
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新しい発話が届いたら、いちばん下まで送る
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  // 読み上げは、エージェントの確定した発話の最後の 1 件だけ（途中経過を一文字ずつ読ませない。自分の発話は読み返さない）
  const lastFinal = [...messages].reverse().find((message) => isFinal(message) && !speakerOf(message).mine);

  async function submit() {
    const text = draft.trim().slice(0, MAX_CHAT_CHARS);
    if (!text || disabled) return;
    setSendError(null);
    try {
      await send(text);
      setDraft("");
    } catch {
      setSendError("送れませんでした。接続を確かめて、もう一度送ってください。");
    }
  }

  return (
    <Container header={<Header variant="h2">会話</Header>} fitHeight>
      <SpaceBetween size="s">
        {/* 会話欄そのものはライブリージョンにしない（途中の文字起こしが更新のたびに読まれるため）。キーボードでスクロールできるよう focus を受ける */}
        <div style={{ maxHeight: 420, minHeight: 200, overflowY: "auto" }} role="region" aria-label="会話の記録" tabIndex={0}>
          {messages.length === 0 ? (
            <Box color="text-status-inactive">まだ発話はありません。</Box>
          ) : (
            <SpaceBetween size="xs">
              {messages.map((message) => {
                const speaker = speakerOf(message);
                return (
                  <div key={message.id} style={{ textAlign: speaker.mine ? "right" : "left" }}>
                    <Box variant="small" color="text-body-secondary">
                      {speaker.label}
                    </Box>
                    <Box>{message.message}</Box>
                  </div>
                );
              })}
            </SpaceBetween>
          )}
          <div ref={bottomRef} />
        </div>
        <div style={VISUALLY_HIDDEN} aria-live="polite" aria-atomic="true">
          {lastFinal ? `${speakerOf(lastFinal).label}: ${lastFinal.message}` : ""}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <SpaceBetween size="xs" direction="horizontal" alignItems="center">
            <div style={{ minWidth: 260 }}>
              <Input
                value={draft}
                onChange={({ detail }) => setDraft(detail.value.slice(0, MAX_CHAT_CHARS))}
                placeholder={disabled ? "接続すると送れます" : "文字で質問する（例: 先月と比べてクリックが落ちたページは？）"}
                disabled={disabled}
                ariaLabel="チャットの入力"
              />
            </div>
            <Button formAction="submit" disabled={disabled || !draft.trim()} loading={isSending}>
              送る
            </Button>
          </SpaceBetween>
        </form>
        {sendError ? <Box color="text-status-error">{sendError}</Box> : null}
      </SpaceBetween>
    </Container>
  );
}
