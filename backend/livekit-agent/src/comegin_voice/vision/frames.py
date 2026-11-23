"""画面共有・カメラの最新フレームを持つ（保存しない）。

- 参加者の映像トラックを購読したら、トラックごとに `rtc.VideoStream`（capacity=1）を開き、
  最新のフレームだけをメモリに残す。古いフレームは捨てる。ファイルにもログにも書かない。
- `latest()` は画面共有を優先し、無ければカメラのフレームを返す。どちらも無ければ None。
- 購読が外れたら、そのトラックのストリームを閉じてフレームも捨てる。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Literal

from livekit import rtc

logger = logging.getLogger("comegin_voice.vision")

FrameSource = Literal["screen_share", "camera"]

# 優先の順（先が優先）
_PRIORITY: tuple[FrameSource, ...] = ("screen_share", "camera")


def _source_of(publication: rtc.TrackPublication) -> FrameSource | None:
    if publication.source == rtc.TrackSource.SOURCE_SCREENSHARE:
        return "screen_share"
    if publication.source == rtc.TrackSource.SOURCE_CAMERA:
        return "camera"
    return None


@dataclass
class _TrackReader:
    """1 本の映像トラックの読み取り（最新のフレームだけを持つ）。"""

    source: FrameSource
    stream: rtc.VideoStream
    task: asyncio.Task[None] | None = None
    frame: rtc.VideoFrame | None = None
    order: int = 0
    """購読した順。同じ種類が複数あるときは新しいほうを使う。"""
    closed: bool = field(default=False)


class LatestFrameBuffer:
    """画面共有を優先し、無ければカメラの最新フレームを持つ。保存しない。"""

    def __init__(self, room: rtc.Room) -> None:
        self._room = room
        self._readers: dict[str, _TrackReader] = {}  # キーはトラックの sid
        self._counter = 0
        self._closed = False
        self._pending: set[asyncio.Task[None]] = (
            set()
        )  # 閉じる途中のタスク（GC で消えないように持つ）

        room.on("track_subscribed", self._on_track_subscribed)
        room.on("track_unsubscribed", self._on_track_unsubscribed)

        # 接続より前に購読済みのトラック（エージェントの参加より先に共有を始めていた場合）
        for participant in room.remote_participants.values():
            for publication in participant.track_publications.values():
                track = publication.track
                if track is not None and track.kind == rtc.TrackKind.KIND_VIDEO:
                    self._open(track, publication)

    def latest(self) -> rtc.VideoFrame | None:
        """画面共有 → カメラの順で、最新のフレームを返す。無ければ None。"""
        found = self.latest_with_source()
        return found[0] if found else None

    def latest_with_source(self) -> tuple[rtc.VideoFrame, FrameSource] | None:
        """latest() と同じ選び方で、フレームとその種類（画面共有・カメラ）を返す。"""
        for source in _PRIORITY:
            candidates = [
                r
                for r in self._readers.values()
                if r.source == source and r.frame is not None
            ]
            if candidates:
                newest = max(candidates, key=lambda r: r.order)
                assert newest.frame is not None
                return newest.frame, source
        return None

    def has_video(self) -> bool:
        """画面共有かカメラのトラックを購読しているか（フレームがまだ届いていなくても True）。"""
        return bool(self._readers)

    async def aclose(self) -> None:
        """購読をやめ、ストリームを閉じ、持っているフレームを捨てる。"""
        if self._closed:
            return
        self._closed = True
        self._room.off("track_subscribed", self._on_track_subscribed)
        self._room.off("track_unsubscribed", self._on_track_unsubscribed)
        readers = list(self._readers.values())
        self._readers.clear()
        await asyncio.gather(
            *(self._close_reader(r) for r in readers),
            *self._pending,
            return_exceptions=True,
        )

    # --- イベント ---

    def _on_track_subscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            self._open(track, publication)

    def _on_track_unsubscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        reader = self._readers.pop(track.sid, None)
        if reader is not None:
            logger.info("映像の購読が外れた", extra={"source": reader.source})
            task = asyncio.create_task(self._close_reader(reader))
            self._pending.add(task)
            task.add_done_callback(self._pending.discard)

    # --- 内部 ---

    def _open(self, track: rtc.Track, publication: rtc.TrackPublication) -> None:
        if self._closed or track.sid in self._readers:
            return
        source = _source_of(publication)
        if source is None:
            return
        self._counter += 1
        # capacity=1: 読み手が遅れても、最新の 1 枚だけを残す
        reader = _TrackReader(
            source=source,
            stream=rtc.VideoStream(track, capacity=1),
            order=self._counter,
        )
        reader.task = asyncio.create_task(self._read(reader))
        self._readers[track.sid] = reader
        logger.info("映像の購読を始めた", extra={"source": source})

    async def _read(self, reader: _TrackReader) -> None:
        try:
            async for event in reader.stream:
                if reader.closed:
                    break
                reader.frame = event.frame
        except Exception:
            # 読み取りの失敗は、そのトラックのフレームが無くなるだけにする（会話は止めない）
            logger.warning(
                "映像の読み取りに失敗した",
                extra={"source": reader.source},
                exc_info=True,
            )
        finally:
            reader.frame = None

    async def _close_reader(self, reader: _TrackReader) -> None:
        reader.closed = True
        reader.frame = None
        try:
            await reader.stream.aclose()
        except Exception:
            logger.debug("映像のストリームを閉じるときに失敗した", exc_info=True)
        if reader.task is not None and not reader.task.done():
            reader.task.cancel()
