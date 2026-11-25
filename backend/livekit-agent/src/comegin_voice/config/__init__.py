"""環境変数の検証（失敗時は変数名と理由だけを出して終了する）。"""

from comegin_voice.config.settings import Settings, load_settings

__all__ = ["Settings", "load_settings"]
