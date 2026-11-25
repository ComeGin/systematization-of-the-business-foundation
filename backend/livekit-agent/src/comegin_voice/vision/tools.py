"""関数ツール look_at_shared_screen（D5・U8）。

GPT-Live は映像を受けない（spec の C1）ので、聞かれたときだけ、画面共有（無ければカメラ）の
最新の 1 フレームを JPEG（長辺 1024 に収める）にして、OpenAI Responses のビジョンモデルに渡す。
戻り値は、画面から読み取れる事実の短い日本語の文。フレームは保存しない（メモリ上で送るだけ）。

失敗はどれも例外にせず、短い事実の文で返す（裏のモデルがそのまま「見られなかった」と伝えられるように）。
"""

import asyncio
import base64
import logging
import time
from typing import TYPE_CHECKING

from livekit.agents import FunctionTool, function_tool
from livekit.agents.utils.images import EncodeOptions, ResizeOptions, encode
from openai import APIError, APITimeoutError, AsyncOpenAI

from comegin_voice.vision.frames import LatestFrameBuffer

if TYPE_CHECKING:
    from comegin_voice.config.settings import Settings

logger = logging.getLogger("comegin_voice.vision")

TOOL_NAME = "look_at_shared_screen"

# 長辺をこの大きさに収める（縦横比は保つ）
_MAX_EDGE = 1024
_JPEG_QUALITY = 80
_TIMEOUT_S = 30.0
_MAX_QUESTION_CHARS = 500
# 1 セッションでビジョンモデルを呼べる回数の既定（settings.max_vision_calls が無いとき）。画像の入力は費用が大きいので上限を置く
_DEFAULT_MAX_VISION_CALLS = 10

_NO_FRAME = "画面共有がありません。ユーザーに、画面共有（またはカメラ）を始めてから、もう一度聞いてもらってください。"
_NO_FRAME_YET = "画面共有は始まっていますが、まだ映像が届いていません。数秒おいてから、もう一度試してください。"
_LIMIT_REACHED = "今回のセッションで画面を読める回数の上限（{limit} 回）に達したため、画面は読み取っていません。画面の内容は、ユーザーに口頭で説明してもらってください。"

_VISION_INSTRUCTIONS = """\
あなたは、ユーザーが共有した画面（またはカメラの映像）の 1 枚の静止画を読み取る係です。
- 質問に関係する、画面から読み取れる事実だけを、日本語で 3〜5 文に短くまとめてください。
- 数値・日付・ラベル・グラフの軸と形（山・谷・傾き）は、画面に見えるとおりに書いてください。読めない数値は「読み取れない」と書き、推測しないでください。
- 画面に無いこと（原因・背景・一般論）は書かないでください。解釈は別の担当が行います。
- 画面が質問と無関係なら、そのことと、画面に何が映っているかを 1 文で書いてください。
- 画面に個人情報やパスワードらしきものが映っていても、その値は書き写さないでください。
"""


def _encode_jpeg_data_url(buffer: LatestFrameBuffer) -> tuple[str, str] | None:
    """最新のフレームを JPEG の data URL にする。無ければ None。CPU を使うのでスレッドで呼ぶ。"""
    found = buffer.latest_with_source()
    if found is None:
        return None
    frame, source = found
    image = encode(
        frame,
        EncodeOptions(
            format="JPEG",
            quality=_JPEG_QUALITY,
            resize_options=ResizeOptions(
                width=_MAX_EDGE, height=_MAX_EDGE, strategy="scale_aspect_fit"
            ),
        ),
    )
    return f"data:image/jpeg;base64,{base64.b64encode(image).decode('ascii')}", source


def build_vision_tool(buffer: LatestFrameBuffer, settings: "Settings") -> FunctionTool:
    """look_at_shared_screen を作る。OpenAI のクライアントはこのツールが 1 つ持つ。

    1 セッションに 1 つ作る（buffer がセッションごとなので）。ビジョンモデルを呼んだ回数をこのツールが数え、
    上限（settings.max_vision_calls。無ければ 10）に達したら、OpenAI を呼ばずに上限に達したことを返す。
    """
    client = AsyncOpenAI(
        api_key=settings.openai_api_key.get_secret_value(),
        timeout=_TIMEOUT_S,
        max_retries=1,
    )
    model = settings.vision_model
    max_calls = int(getattr(settings, "max_vision_calls", _DEFAULT_MAX_VISION_CALLS))
    calls = 0  # ビジョンモデルを呼んだ回数（失敗した呼び出しも数える。費用が出るのは呼んだ時点のため）

    @function_tool(name=TOOL_NAME)
    async def look_at_shared_screen(question: str) -> str:
        """ユーザーが共有している画面（無ければカメラ）の今の 1 枚を見て、質問に関係する事実を返す。
        ユーザーが「この画面」「このグラフ」「今映っているもの」など、画面の内容について聞いたときだけ呼ぶ。
        返すのは画面から読み取れる事実だけで、解釈は含まない。数値は画面の表示どおり。

        Args:
            question: 画面について確かめたいこと（日本語。例:「このグラフの谷はいつで、値はいくつか」）。
        """
        nonlocal calls
        if calls >= max_calls:
            logger.info("画面の読み取りの上限に達した", extra={"limit": max_calls})
            return _LIMIT_REACHED.format(limit=max_calls)
        q = question.strip()[:_MAX_QUESTION_CHARS] or "画面に何が映っているか"
        started = time.monotonic()
        try:
            encoded = await asyncio.to_thread(_encode_jpeg_data_url, buffer)
        except Exception:
            logger.warning("フレームの JPEG への変換に失敗した", exc_info=True)
            return "画面の映像を画像に変換できませんでした。もう一度試すか、画面共有をやり直してもらってください。"
        if encoded is None:
            return _NO_FRAME_YET if buffer.has_video() else _NO_FRAME
        data_url, source = encoded
        source_label = "画面共有" if source == "screen_share" else "カメラ"

        calls += 1

        try:
            response = await client.responses.create(
                model=model,
                instructions=_VISION_INSTRUCTIONS,
                input=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": f"質問: {q}"},
                            {
                                "type": "input_image",
                                "image_url": data_url,
                                "detail": "auto",
                            },
                        ],
                    }
                ],
                # 音声の会話なので待ち時間を短くする（既定の VISION_MODEL は推論モデル）
                reasoning={"effort": "low"},
                store=False,
            )
        except APITimeoutError:
            logger.warning(
                "ビジョンモデルが時間内に応答しなかった", extra={"model": model}
            )
            return "画面の読み取りが時間切れになりました（ビジョンモデルが応答しませんでした）。"
        except APIError as error:
            # 本文には入力が含まれうるので、種類と状態だけを残す
            status = getattr(error, "status_code", None)
            logger.warning(
                "ビジョンモデルの呼び出しに失敗した",
                extra={"model": model, "status": status, "error": type(error).__name__},
            )
            return f"画面の読み取りに失敗しました（ビジョンモデルのエラー: {type(error).__name__}{f' {status}' if status else ''}）。"
        except Exception as error:
            logger.warning(
                "ビジョンモデルの呼び出しで想定外の失敗",
                extra={"model": model, "error": type(error).__name__},
            )
            return f"画面の読み取りに失敗しました（{type(error).__name__}）。"

        text = (response.output_text or "").strip()
        logger.info(
            "画面を読み取った",
            extra={
                "model": model,
                "source": source,
                "elapsed_ms": int((time.monotonic() - started) * 1000),
            },
        )
        if not text:
            return "画面を読み取りましたが、ビジョンモデルから文が返りませんでした。"
        return f"（{source_label}の今の 1 枚から読み取った事実）{text}"

    return look_at_shared_screen
