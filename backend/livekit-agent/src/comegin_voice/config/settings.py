"""環境変数を検証して ``Settings`` にする。

MCP サーバー（``backend/*-mcp/src/config.ts``）と同じ方針で、検証に失敗したら
**変数名と理由だけ**を stderr に出して終了コード 1 で止める。値は出さない（秘密を含むため）。

話者分離のプラグイン（ai-coustics・Krisp）は有償のライセンスが要る。
``AUDIO_ENHANCEMENT`` でそれを選んだのにライセンスやプラグインが無いときも、ここで止める
（セッションが始まってから失敗すると、利用者には「声が届かない」としか見えないため）。
"""

from __future__ import annotations

import importlib.util
import ipaddress
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    ValidationError,
    field_validator,
)

AudioEnhancement = Literal["apm", "off", "ai_coustics", "krisp"]


class Settings(BaseModel):
    """エージェントの設定。1 プロセスに 1 つ。作ったあとは変えない（frozen）。"""

    model_config = ConfigDict(frozen=True, extra="forbid")

    # LiveKit（SFU）。開発は backend/livekit-system の --dev（ws://127.0.0.1:7880）、本番は wss://rtc.comegin.com
    livekit_url: str
    livekit_api_key: SecretStr
    livekit_api_secret: SecretStr
    # OpenAI（GPT-Live と、裏の Responses・ビジョン）
    openai_api_key: SecretStr
    # OpenSEO の MCP（local_noauth。ループバックだけ。spec の C6）
    openseo_mcp_url: str = "http://127.0.0.1:3001/mcp"
    openseo_project_domain: str = "comegin.com"
    # dispatch の名前。監視アプリの LIVEKIT_AGENT_NAME と同じ値にする
    agent_name: str = "comegin-seo-bi"
    gpt_live_voice: str = "marin"
    backend_model: str = "gpt-5.6-luna"
    vision_model: str = "gpt-5.6-luna"
    session_max_minutes: int = Field(default=30, ge=1, le=120)
    max_tool_calls: int = Field(default=40, ge=1, le=200)
    # 画面を読むツール（look_at_shared_screen）を 1 セッションで呼べる回数の上限（vision/tools.py が読む）
    max_vision_calls: int = Field(default=10, ge=1, le=100)
    # None なら E-12 を書かない（警告を 1 回出す）
    voice_audit_dir: Path | None = None
    audio_enhancement: AudioEnhancement = "apm"

    @field_validator("livekit_url")
    @classmethod
    def _check_livekit_url(cls, value: str) -> str:
        parsed = urlparse(value)
        if parsed.scheme not in ("ws", "wss") or not parsed.hostname:
            raise ValueError("ws:// か wss:// で始まる URL にします")
        return value

    @field_validator("openseo_mcp_url")
    @classmethod
    def _check_openseo_url(cls, value: str) -> str:
        parsed = urlparse(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("http:// か https:// で始まる URL にします")
        # OpenSEO は無認証で、Host が localhost 系でないと 403 を返す（spec の C6）。
        # ループバック以外に向けると、無認証の MCP を外へ開く構成を前提にしてしまうので断る。
        if not _is_loopback(parsed.hostname):
            raise ValueError(
                "ループバック（127.0.0.1・localhost・::1）だけを指定できます"
            )
        if not parsed.path.rstrip("/").endswith("/mcp"):
            raise ValueError(
                "パスは /mcp にします（Streamable HTTP の自動判定がパスで決まるため）"
            )
        return value

    @field_validator("openseo_project_domain")
    @classmethod
    def _check_domain(cls, value: str) -> str:
        if "/" in value or ":" in value or " " in value or "." not in value:
            raise ValueError(
                "ドメイン名だけを書きます（例: comegin.com。スキームやパスを付けない）"
            )
        return value.lower()

    @field_validator("agent_name")
    @classmethod
    def _check_agent_name(cls, value: str) -> str:
        if not value.replace("-", "").replace("_", "").isalnum():
            raise ValueError("英数字・ハイフン・アンダースコアだけにします")
        return value

    @field_validator("voice_audit_dir")
    @classmethod
    def _check_audit_dir(cls, value: Path | None) -> Path | None:
        if value is None:
            return None
        if not value.is_absolute():
            raise ValueError(
                "絶対パスにします（監視アプリの作業ツリーの docs/audits/voice）"
            )
        # 打ち間違いで作業ツリーの外に知らないディレクトリを作らないよう、親（docs/audits）は既にあることを求める
        if not value.parent.is_dir():
            raise ValueError("親ディレクトリ（docs/audits）がありません")
        if value.exists() and not value.is_dir():
            raise ValueError("ディレクトリではありません")
        return value


# Settings の項目 → 環境変数の名前
_ENV_NAMES: dict[str, str] = {
    "livekit_url": "LIVEKIT_URL",
    "livekit_api_key": "LIVEKIT_API_KEY",
    "livekit_api_secret": "LIVEKIT_API_SECRET",
    "openai_api_key": "OPENAI_API_KEY",
    "openseo_mcp_url": "OPENSEO_MCP_URL",
    "openseo_project_domain": "OPENSEO_PROJECT_DOMAIN",
    "agent_name": "LIVEKIT_AGENT_NAME",
    "gpt_live_voice": "GPT_LIVE_VOICE",
    "backend_model": "BACKEND_MODEL",
    "vision_model": "VISION_MODEL",
    "session_max_minutes": "SESSION_MAX_MINUTES",
    "max_tool_calls": "MAX_TOOL_CALLS",
    "max_vision_calls": "MAX_VISION_CALLS",
    "voice_audit_dir": "VOICE_AUDIT_DIR",
    "audio_enhancement": "AUDIO_ENHANCEMENT",
}
_REQUIRED = frozenset(
    {"livekit_url", "livekit_api_key", "livekit_api_secret", "openai_api_key"}
)

# pydantic のエラーの種類 → 日本語の理由（値は含めない）
_REASONS: dict[str, str] = {
    "int_parsing": "整数ではありません",
    "int_from_float": "整数ではありません",
    "greater_than_equal": "小さすぎます",
    "less_than_equal": "大きすぎます",
    "literal_error": "選べる値ではありません",
    "path_type": "パスとして読めません",
    "missing": "未設定です",
}

# 話者分離のプラグインと、そのライセンスの環境変数（spec の U3）
_ENHANCEMENT_REQUIREMENTS: dict[str, tuple[str, tuple[str, ...], str]] = {
    # 選んだ値: (import するモジュール, 必須の環境変数, 入れ方)
    "ai_coustics": (
        "livekit.plugins.ai_coustics",
        ("AI_COUSTICS_API_KEY",),
        "uv sync --extra ai-coustics",
    ),
    "krisp": (
        "livekit.plugins.krisp",
        ("KRISP_VIVA_SDK_LICENSE_KEY", "KRISP_VIVA_FILTER_MODEL_PATH"),
        "uv sync --extra krisp",
    ),
}


def _is_loopback(hostname: str) -> bool:
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _reason(error_type: str, message: str) -> str:
    if error_type == "value_error":
        # field_validator が投げた日本語の理由。pydantic が付ける接頭辞だけ外す
        return message.removeprefix("Value error, ")
    if error_type == "literal_error":
        return "次のいずれかにします: apm, off, ai_coustics, krisp"
    return _REASONS.get(error_type, "形が正しくありません")


def _check_enhancement(
    settings: Settings, env: Mapping[str, str]
) -> list[tuple[str, str]]:
    requirement = _ENHANCEMENT_REQUIREMENTS.get(settings.audio_enhancement)
    if requirement is None:
        return []
    module, variables, install = requirement
    errors: list[tuple[str, str]] = []
    try:
        found = importlib.util.find_spec(module) is not None
    except ModuleNotFoundError:
        found = False
    if not found:
        errors.append(
            ("AUDIO_ENHANCEMENT", f"プラグインが入っていません（{install} で入れます）")
        )
    for name in variables:
        if not env.get(name, "").strip():
            errors.append(
                (name, f"AUDIO_ENHANCEMENT={settings.audio_enhancement} では必須です")
            )
    model_path = env.get("KRISP_VIVA_FILTER_MODEL_PATH", "").strip()
    if settings.audio_enhancement == "krisp" and model_path:
        if not model_path.endswith(".kef"):
            errors.append(
                ("KRISP_VIVA_FILTER_MODEL_PATH", ".kef のファイルを指定します")
            )
        elif not Path(model_path).is_file():
            errors.append(("KRISP_VIVA_FILTER_MODEL_PATH", "ファイルがありません"))
    return errors


def _fail(errors: list[tuple[str, str]]) -> None:
    print("設定に誤りがあるため起動を止めます（値は表示しません）", file=sys.stderr)
    for name, reason in errors:
        print(f"  - {name}: {reason}", file=sys.stderr)
    raise SystemExit(1)


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    """環境変数から ``Settings`` を作る。失敗したら変数名と理由だけを stderr に出して終了する。

    Args:
        environ: 読む環境変数。省略時は ``os.environ``。
    """
    env = os.environ if environ is None else environ
    raw: dict[str, str] = {}
    errors: list[tuple[str, str]] = []
    for field, name in _ENV_NAMES.items():
        value = env.get(name, "").strip()
        if not value:
            # 空は「未設定」と同じに扱い、既定値を使う
            if field in _REQUIRED:
                errors.append((name, "未設定です"))
            continue
        raw[field] = value

    settings: Settings | None = None
    try:
        settings = Settings.model_validate(raw)
    except ValidationError as exc:
        for err in exc.errors(
            include_url=False, include_input=False, include_context=False
        ):
            field = str(err["loc"][0]) if err["loc"] else ""
            name = _ENV_NAMES.get(field, field)
            if field in _REQUIRED and field not in raw:
                continue  # 未設定はすでに数えた
            errors.append((name, _reason(err["type"], err["msg"])))

    if settings is not None:
        errors.extend(_check_enhancement(settings, env))
    if errors or settings is None:
        _fail(errors)
    assert settings is not None
    return settings
