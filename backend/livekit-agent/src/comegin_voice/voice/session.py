"""``AgentSession`` と ``RoomOptions`` を組み立てる（spec の 5.2 の 4、D7・D11）。

- 会話のモデル（GPT-Live）は、セッションごとに指示（projectId と今日の日付を埋め込む）が変わるので、
  ``Agent`` 側（``src/agent.py`` の ``SeoBiAgent``）に持たせる。ここでは作らない（``build_live_model`` で作る）。
- GPT-Live では、セッション既定の VAD（LiveKit Inference の VAD。セルフホストでは使えない）が外れる。
  割り込みで再生を止めるには、ローカルの Silero VAD を明示して渡す（spec の C4・C5）。
- 割り込みは ``vad`` モードにする（適応型の判定は LiveKit Inference が要る）。止まるのは再生だけで、
  モデルは聞かせていない部分も覚えている（spec の 4 節 (c)）。言い直さない指示は ``voice/persona.py``。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from livekit.agents import AgentSession, TurnHandlingOptions, room_io
from livekit.agents import vad as lk_vad
from livekit.plugins import openai, silero

from comegin_voice.voice.audio_processing import build_noise_cancellation

if TYPE_CHECKING:
    from comegin_voice.config.settings import Settings

# 割り込みと判定する発話の最短の長さ（秒）。相づちで再生を止めないための値（D7）
MIN_INTERRUPTION_SECONDS = 0.5
# 誤った割り込み（その後に何も話さなかった）とみなすまでの無音（秒）。
# resume_false_interruption が GPT-Live で効くかは G-2 でログを見て確かめ、効かなければ外す（D7）
FALSE_INTERRUPTION_TIMEOUT_SECONDS = 2.0
# 利用者もエージェントも話さない時間がこれを超えたら away にする（秒）。
# away になったら一度だけ確認し、AWAY_GRACE_SECONDS のうちに戻らなければ閉じる（src/agent.py。D11）
USER_AWAY_TIMEOUT_SECONDS = 120.0
AWAY_GRACE_SECONDS = 30.0


def load_vad() -> lk_vad.VAD:
    """Silero VAD を読み込む。時間がかかるので、プロセスの準備（prewarm）で 1 回だけ呼ぶ。"""
    return silero.VAD.load()


def build_session(settings: Settings, *, vad: lk_vad.VAD | None = None) -> AgentSession:
    """セッションを作る。

    Args:
        settings: 設定。
        vad: prewarm で読み込んだ VAD。省略時はここで読み込む（遅い）。
    """
    del settings  # いまは使わない（上限は src/agent.py が時計で見る）。契約の形をそろえるために受け取る
    return AgentSession(
        vad=vad if vad is not None else load_vad(),
        turn_handling=TurnHandlingOptions(
            interruption={
                "enabled": True,
                "mode": "vad",
                "min_duration": MIN_INTERRUPTION_SECONDS,
                "resume_false_interruption": True,
                "false_interruption_timeout": FALSE_INTERRUPTION_TIMEOUT_SECONDS,
            },
        ),
        user_away_timeout=USER_AWAY_TIMEOUT_SECONDS,
    )


def build_room_options(settings: Settings) -> room_io.RoomOptions:
    """部屋の入出力の設定。

    - 音声の入力: 音声強化（``AUDIO_ENHANCEMENT``）と AGC。``off`` のときは AGC も切る（聞き比べのため）。
    - テキストの入力: 既定のまま（画面のチャット欄。``lk.chat``。spec の 4 節 (b)・D6）。
    - 映像の入力: 使わない。GPT-Live は映像を受けない（spec の C1）。画面共有は
      ``vision/frames.py`` の ``LatestFrameBuffer`` が自分で購読する。
    - 文字起こしの出力: 既定のまま（画面の文字起こし）。
    - セッションを閉じたら部屋を消す（30 分の上限・無発話で閉じたとき、ブラウザも切る）。
    """
    enhanced = settings.audio_enhancement != "off"
    return room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(
            noise_cancellation=build_noise_cancellation(settings),
            auto_gain_control=enhanced,
        ),
        video_input=False,
        delete_room_on_close=True,
    )


def build_live_model(
    settings: Settings, *, backend_instructions: str
) -> openai.realtime.GPTLiveModel:
    """GPT-Live（OpenAI のプラグイン）を作る。声と指示はセッションの途中で変えられない（spec の C2）。

    Args:
        settings: 設定。
        backend_instructions: 裏の Responses のモデルの指示（``bi/analyst.py`` が作る）。
    """
    return openai.realtime.GPTLiveModel(
        voice=settings.gpt_live_voice,
        responses_options={
            "model": settings.backend_model,
            "instructions": backend_instructions,
            "reasoning": {"effort": "low"},
            "text": {"verbosity": "low"},
            "parallel_tool_calls": True,
        },
        api_key=settings.openai_api_key.get_secret_value(),
    )
