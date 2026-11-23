"""音声の SEO BI エージェント（comegin-seo-bi）の入口。

ここでは各モジュールの配線だけを行う（spec の 9 節の処理の順）。

1. ``load_settings``（失敗したら変数名と理由だけを出して止まる）
2. ``rtc_session(agent_name)``（明示の dispatch。監視アプリのトークンの ``room_config`` が呼ぶ）
3. ``ctx.connect``
4. ``BiSessionState``・``OpenSeoClient``・``RoomCardSink``・``LatestFrameBuffer`` を作る
5. ``resolve_project_id``（0 件・複数件・OpenSEO に届かないときは縮退する）
6. ``SeoBiAgent``（声の指示・GPT-Live・ツール）を作る
7. ``session.start``
8. ``on_enter`` で ``run_briefing`` → ``append_thinking(facts)`` → ``generate_reply``
9. 終了時のコールバックで ``log_usage``・``write_voice_audit``・``aclose``

起動: ``uv run src/agent.py dev``（開発）／ ``uv run src/agent.py start``（オンプレの常駐。systemd）。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    UserStateChangedEvent,
    cli,
    llm,
)
from livekit.plugins.openai.realtime import GPTLiveSession

from comegin_voice.bi.analyst import build_backend_instructions
from comegin_voice.bi.briefing import BriefingResult, run_briefing
from comegin_voice.bi.state import BiSessionState
from comegin_voice.config.settings import Settings, load_settings
from comegin_voice.observability.audit import write_voice_audit
from comegin_voice.observability.questions import UtteranceBuffer, summarize_questions
from comegin_voice.observability.session_log import log_usage
from comegin_voice.openseo.client import OpenSeoClient, OpenSeoError
from comegin_voice.openseo.toolset import build_openseo_toolset
from comegin_voice.vision.frames import LatestFrameBuffer
from comegin_voice.vision.tools import build_vision_tool
from comegin_voice.visual_output.cards import CardSink, RoomCardSink
from comegin_voice.voice.persona import VOICE_INSTRUCTIONS
from comegin_voice.voice.session import (
    AWAY_GRACE_SECONDS,
    build_live_model,
    build_room_options,
    build_session,
    load_vad,
)

logger = logging.getLogger("comegin_voice.agent")

JST = ZoneInfo("Asia/Tokyo")
# 上限の何秒前に「締めくくり」を伝えるか（D11）
_WRAP_UP_BEFORE_SECONDS = 60.0

# 開発ではプロジェクト直下の .env.local を読む（オンプレの常駐では systemd の EnvironmentFile で渡す）。
# 既に設定されている環境変数は上書きしない。
load_dotenv(Path(__file__).resolve().parents[1] / ".env.local", override=False)
settings: Settings = load_settings()

# プロジェクトを決められなかったときの裏のモデルの指示（OpenSEO のツールを渡さない。数値を推測させない）
_DEGRADED_BACKEND_INSTRUCTIONS = """\
あなたは、声のモデルから委ねられた仕事を処理する、SEO の BI の分析担当です。
いまは OpenSEO（Search Console と GA4 の中継）のプロジェクトを決められず、検索やアクセス解析の数値を取得できません。
- 検索・アクセス解析の数値を問われたら、取得できない状態であることだけを短く返します。数値を推測して返してはいけません。
- 共有された画面やカメラの内容を問われたら、画面を読むツールを使い、見えた事実だけを返します。
- 返す文は、声のモデルがそのまま読み上げられる短い日本語にします。
"""


def today_jst() -> date:
    return datetime.now(JST).date()


class SeoBiAgent(Agent):
    """音声の SEO BI の担当者（1 体だけ。GPT-Live はハンドオフで新しいセッションになるため。D1・C2）。

    接続した直後に W1（ブリーフィング）を行い、その後は W2（質疑）として裏のモデルがツールを呼ぶ。
    """

    def __init__(
        self,
        *,
        live_model: llm.DuplexModel,
        tools: list[llm.Tool | llm.Toolset],
        state: BiSessionState,
        client: OpenSeoClient,
        sink: CardSink,
        degraded_outcome: str | None,
    ) -> None:
        super().__init__(instructions=VOICE_INSTRUCTIONS, llm=live_model, tools=tools)
        self._state = state
        self._client = client
        self._sink = sink
        self._degraded_outcome = degraded_outcome
        self.briefing: BriefingResult | None = None
        self._briefing_task: asyncio.Task[BriefingResult | None] | None = None

    async def on_enter(self) -> None:
        if self._degraded_outcome is not None:
            await self._say(
                "あいさつをし、いまは検索とアクセス解析の数値を取得できない状態であることを一度だけ短く伝えます。"
                "数値は言いません。共有した画面の内容についてなら答えられると伝えます。"
            )
            return

        # ブリーフィングの集計（並列で OpenSEO を呼ぶ）と、待ってもらう一言を同時に進める。
        # タスクは自分で持ち、on_enter が取り消されたら止める（会話の終了後に OpenSEO を呼び続けないため）
        self._briefing_task = asyncio.create_task(self._run_briefing())
        try:
            await self._say(
                "短くあいさつし、最新の検索とアクセス解析の数値を確認しているので少し待ってほしいと一言だけ伝えます。"
            )
            result = await self._briefing_task
            self.briefing = result
            await self._present_briefing(result)
        finally:
            if not self._briefing_task.done():
                self._briefing_task.cancel()

    async def stop_briefing(self) -> None:
        """W1 のタスクを止めて、止まるまで待つ（終了時のコールバックの先頭で呼ぶ）。"""
        task = self._briefing_task
        if task is None:
            return
        if not task.done():
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def _present_briefing(self, result: BriefingResult | None) -> None:
        if result is not None and result.facts:
            try:
                # 黙って知っておく事実（500 トークンまで）。数値には結果 ID が付いている
                duplex = self.duplex_session
                if not isinstance(duplex, GPTLiveSession):
                    raise TypeError("GPT-Live のセッションではありません")
                duplex.append_thinking(result.facts)
            except Exception:
                logger.warning("ブリーフィングの事実を渡せませんでした", exc_info=True)
                result = None
                self.briefing = None  # 渡せなかった事実は E-12 に「伝えた」と書かない

        if result is None or result.outcome == "failed":
            await self._say(
                "数値の取得に失敗したことを一度だけ短く伝えます。数値は言いません。"
                "知りたいことを聞いてもらえれば、改めて調べると伝えます。"
            )
            return
        partial = (
            "一部の数値は取得できなかったので、取れたものだけで話し、取れなかったことも一言添えます。"
            if result.outcome == "partial"
            else ""
        )
        await self._say(
            "届いている事実をもとに、ブリーフィングを 3 点以内で話します。計測に問題があればそれを最初に伝えます。"
            "各点は事実、解釈、次の一手の順にし、最後に何を詳しく見たいかを一つだけ尋ねます。"
            + partial
        )

    async def _run_briefing(self) -> BriefingResult | None:
        try:
            return await run_briefing(
                self._client, self._state, self._sink, today=today_jst()
            )
        except Exception:
            # run_briefing は失敗を outcome で返す約束。それでも漏れた例外は、ここで縮退に変える
            logger.exception("ブリーフィングで想定外の失敗がありました")
            return None

    async def _say(self, instructions: str) -> None:
        """モデルに一言を促す。GPT-Live は 10 秒で話し始めなければ断ったとみなす（エラーにしない）。"""
        try:
            handle = self.session.generate_reply(instructions=instructions)
            await handle
        except Exception:
            logger.warning("発話の依頼が失敗しました", exc_info=True)
            return
        if handle.exception() is not None:
            logger.info("モデルが発話の依頼に応じませんでした")


def prewarm(proc: JobProcess) -> None:
    # Silero VAD の読み込みは遅いので、ジョブのプロセスを用意するときに 1 回だけ行う
    proc.userdata["vad"] = load_vad()


server = AgentServer(
    ws_url=settings.livekit_url,
    api_key=settings.livekit_api_key.get_secret_value(),
    api_secret=settings.livekit_api_secret.get_secret_value(),
    # ヘルスの HTTP は 127.0.0.1 だけで受ける（ポートは start で 8081。dev では空いているポート）
    host="127.0.0.1",
    # 終了時のコールバック（問いの要約〈最大 15 秒〉→ E-12 の書き出し）が既定の 10 秒で打ち切られないようにする
    shutdown_process_timeout=30.0,
    # 止めるとき（SIGTERM）は、会話が自然に終わるのを最大 60 秒だけ待つ（既定は 3600 秒）。過ぎたら cli が
    # server.aclose() に進み、会話のプロセスに終了を求める。会話のプロセスは SIGTERM を無視している
    # （ipc/job_proc_lazy_main.py）ので、終了の要求を受けてから終了時のコールバック（usage・問いの要約・E-12）を
    # shutdown_process_timeout の範囲で動かす。systemd の TimeoutStopSec はこれより長くする（120 秒）
    drain_timeout=60,
)
server.setup_fnc = prewarm


def _watch_limits(ctx: JobContext, session: AgentSession) -> None:
    """30 分の上限と、無発話（away）での終了を見張る（D11）。"""
    limit = float(settings.session_max_minutes * 60)
    away_task: asyncio.Task[None] | None = None

    async def wrap_up_then_close() -> None:
        await asyncio.sleep(max(0.0, limit - _WRAP_UP_BEFORE_SECONDS))
        with contextlib.suppress(Exception):
            session.generate_reply(
                instructions="会話の時間の上限が近いので、1 分ほどで終えることを短く伝え、要点を一言でまとめます。"
            )
        await asyncio.sleep(min(_WRAP_UP_BEFORE_SECONDS, limit))
        logger.info("セッションの上限に達したため閉じます")
        session.shutdown()

    async def check_away() -> None:
        with contextlib.suppress(Exception):
            session.generate_reply(
                instructions="まだ聞いているかを短く一度だけ確認します。"
            )
        await asyncio.sleep(AWAY_GRACE_SECONDS)
        logger.info("利用者の応答が無いため閉じます")
        session.shutdown()

    def on_user_state_changed(ev: UserStateChangedEvent) -> None:
        nonlocal away_task
        if ev.new_state == "away":
            if away_task is None or away_task.done():
                away_task = asyncio.create_task(check_away())
            return
        if away_task is not None:
            away_task.cancel()
            away_task = None

    limit_task = asyncio.create_task(wrap_up_then_close())
    session.on("user_state_changed", on_user_state_changed)

    async def cancel_watchers() -> None:
        limit_task.cancel()
        if away_task is not None:
            away_task.cancel()

    ctx.add_shutdown_callback(cancel_watchers)


@server.rtc_session(agent_name=settings.agent_name)
async def seo_bi_session(ctx: JobContext) -> None:
    await ctx.connect()

    state = BiSessionState.create()
    ctx.log_context_fields = {"room": ctx.room.name, "session_id": state.session_id}
    client = OpenSeoClient(settings.openseo_mcp_url)
    sink = RoomCardSink(ctx.room)
    frames = LatestFrameBuffer(ctx.room)

    # プロジェクトを決める。決められないときは縮退する（W1 を出さず、OpenSEO のツールを渡さない）
    degraded_outcome: str | None = None
    try:
        state.project_id = await client.resolve_project_id(
            settings.openseo_project_domain
        )
    except OpenSeoError as exc:
        degraded_outcome = exc.outcome
        logger.warning(
            "OpenSEO のプロジェクトを決められないため、縮退して始めます",
            extra={"outcome": exc.outcome},
        )

    tools: list[llm.Tool | llm.Toolset] = [build_vision_tool(frames, settings)]
    if state.project_id is not None:
        backend_instructions = build_backend_instructions(
            project_id=state.project_id, today=today_jst()
        )
        tools.insert(0, build_openseo_toolset(settings, state, sink))
    else:
        backend_instructions = _DEGRADED_BACKEND_INSTRUCTIONS

    agent = SeoBiAgent(
        live_model=build_live_model(
            settings, backend_instructions=backend_instructions
        ),
        tools=tools,
        state=state,
        client=client,
        sink=sink,
        degraded_outcome=degraded_outcome,
    )
    session = build_session(settings, vad=ctx.proc.userdata.get("vad"))
    # 利用者の確定した発話をメモリだけに溜める（E-12 の「問い」の要約の材料。ログ・ファイルには出さない）
    utterances = UtteranceBuffer()
    utterances.attach(session)

    async def on_shutdown(reason: str) -> None:
        logger.info("セッションを終えます", extra={"reason": reason})
        # 先に W1 を止める。止まるまでは state.results が増えうるので、E-12 はその後に書く
        await agent.stop_briefing()
        # 発話をそのまま E-12 に書かない。話題の短い句に要約して入れる（失敗したら空のまま）
        state.questions = await summarize_questions(utterances.items, settings)
        # 問いの数をログに出すため、要約の後に呼ぶ
        log_usage(session, state)
        try:
            await asyncio.to_thread(
                write_voice_audit,
                state,
                settings,
                outcome_hint=degraded_outcome,
                briefing=agent.briefing,
            )
        except Exception:
            logger.exception("E-12 を書けませんでした")
        for closer in (client.aclose, frames.aclose):
            try:
                await closer()
            except Exception:
                logger.warning("後片付けに失敗しました", exc_info=True)

    ctx.add_shutdown_callback(on_shutdown)

    await session.start(
        agent=agent, room=ctx.room, room_options=build_room_options(settings)
    )
    _watch_limits(ctx, session)


if __name__ == "__main__":
    cli.run_app(server)
