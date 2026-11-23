"""エージェント側の音声強化（spec の U3・4 節 (d)）。

``AUDIO_ENHANCEMENT`` で切り替える。

- ``apm``（既定）: WebRTC の APM（``rtc.AudioProcessingModule``）の雑音抑制と低い音のカットを、
  自作の ``rtc.FrameProcessor[rtc.AudioFrame]`` に包んで ``AudioInputOptions.noise_cancellation`` に渡す。
  音量の自動調整（AGC）は、フレームワークの ``AudioInputOptions(auto_gain_control=True)`` に任せる。
- ``off``: 何もしない（聞き比べ用。AGC も切る。``voice/session.py``）。
- ``ai_coustics`` / ``krisp``: 有償の話者分離。プラグインを使うときだけ import する。
  ライセンスの環境変数が無いときは ``config/settings.py`` が起動時に止める。

ブラウザ側は ``echoCancellation`` だけを有効にし、``noiseSuppression``・``autoGainControl`` は切る
（抑制を二重にかけないため。spec の 5.4）。
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

from livekit import rtc

if TYPE_CHECKING:
    from comegin_voice.config.settings import Settings

logger = logging.getLogger(__name__)

# APM は 10 ms ずつしか処理しない（rtc.AudioProcessingModule.process_stream の注記）
_APM_FRAME_MS = 10
_BYTES_PER_SAMPLE = 2  # int16


class ApmNoiseSuppressor(rtc.FrameProcessor[rtc.AudioFrame]):
    """WebRTC の APM（雑音抑制・低い音のカット）を FrameProcessor に包んだもの。

    入力のフレームは既定で 50 ms（``AudioInputOptions.frame_size_ms``）なので、10 ms ずつに分けて
    処理し、同じ長さのフレームにつなぎ直して返す。10 ms に満たない端数（接続前の音声のバッファなどで
    起こりうる）は処理せずにそのまま残す。APM は内部に状態を持つため、1 本の音声の流れに 1 つを使う。
    """

    def __init__(self) -> None:
        self._enabled = True
        self._apm: rtc.AudioProcessingModule | None = rtc.AudioProcessingModule(
            noise_suppression=True,
            high_pass_filter=True,
        )

    @property
    def enabled(self) -> bool:
        return self._enabled and self._apm is not None

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    def _process(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
        apm = self._apm
        if apm is None:
            return frame
        chunk = frame.sample_rate * _APM_FRAME_MS // 1000
        if chunk <= 0 or frame.samples_per_channel < chunk:
            return frame

        chunk_bytes = chunk * frame.num_channels * _BYTES_PER_SAMPLE
        out = bytearray(frame.data.cast("B"))
        try:
            for index in range(frame.samples_per_channel // chunk):
                start = index * chunk_bytes
                piece = rtc.AudioFrame(
                    out[start : start + chunk_bytes],
                    frame.sample_rate,
                    frame.num_channels,
                    chunk,
                )
                apm.process_stream(piece)  # piece の中身をその場で書き換える
                out[start : start + chunk_bytes] = piece.data.cast("B")
        except Exception:
            # 対応しないサンプルレートなど。フレームごとに警告が出続けないよう、以後は素通しにする
            logger.warning(
                "APM の音声強化に失敗したため、以後は処理せずに通します",
                extra={
                    "sample_rate": frame.sample_rate,
                    "num_channels": frame.num_channels,
                },
                exc_info=True,
            )
            self._apm = None
            return frame

        return rtc.AudioFrame(
            out,
            frame.sample_rate,
            frame.num_channels,
            frame.samples_per_channel,
            userdata=frame.userdata,
        )

    def _close(self) -> None:
        # APM は FFI のハンドルを持つだけで、明示の解放 API が無い。参照を外して GC に任せる
        self._apm = None


def _build_ai_coustics() -> rtc.FrameProcessor[rtc.AudioFrame]:
    # 有償。uv sync --extra ai-coustics で入れたときだけ import できる
    from livekit.plugins import ai_coustics  # type: ignore[attr-defined]  # optional の依存

    # セルフホストでは LiveKit Cloud の認証が使えないので、ai-coustics のライセンスキーで直接認証する
    # （livekit-docs /transport/media/noise-cancellation の Self-hosted authentication）
    return ai_coustics.audio_enhancement(
        model=ai_coustics.EnhancerModel.QUAIL_VF_S,
        auth=ai_coustics.Auth.ai_coustics_api(
            license_key=os.environ["AI_COUSTICS_API_KEY"]
        ),
    )


def _build_krisp() -> rtc.FrameProcessor[rtc.AudioFrame]:
    # 有償。uv sync --extra krisp で入れたときだけ import できる
    from livekit.plugins import krisp  # type: ignore[attr-defined]  # optional の依存

    # 既定の krisp.auth.livekit_cloud() はセルフホストで使えないので、Krisp のライセンスと .kef を使う
    # （livekit-plugins-krisp の examples/krisp_agent_example.py）
    return krisp.KrispVivaFilterFrameProcessor(
        auth_provider=krisp.auth.krisp_license(
            license_key=os.environ["KRISP_VIVA_SDK_LICENSE_KEY"],
            model_path=os.environ["KRISP_VIVA_FILTER_MODEL_PATH"],
        ),
    )


def build_noise_cancellation(
    settings: Settings,
) -> rtc.FrameProcessor[rtc.AudioFrame] | None:
    """``AUDIO_ENHANCEMENT`` に応じた音声強化を作る。``off`` なら None。

    セッションごとに呼ぶ（APM は状態を持つため、セッションをまたいで使い回さない）。
    """
    mode = settings.audio_enhancement
    if mode == "off":
        return None
    if mode == "ai_coustics":
        return _build_ai_coustics()
    if mode == "krisp":
        return _build_krisp()
    return ApmNoiseSuppressor()
