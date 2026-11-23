"""映像の理解（マルチモーダルの入力）。

GPT-Live は音声専用で映像を受けない（spec の C1）。そのため、画面共有（無ければカメラ）の
最新の 1 フレームだけを持ち、聞かれたときに関数ツールが別のビジョンモデルへ渡す（D5・U8）。
フレームは保存しない。
"""

from comegin_voice.vision.frames import LatestFrameBuffer
from comegin_voice.vision.tools import build_vision_tool

__all__ = ["LatestFrameBuffer", "build_vision_tool"]
