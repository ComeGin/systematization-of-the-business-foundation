# Agent Plugins 1.0.0 の plugin.json のスキーマ

- 取得元: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
- 取得日: 2026-11-09
- `plugin.schema.json` は取得したものをそのまま置いた写し（JSON Schema 2020-12。書き換えていない）
- 仕様: https://agent-plugins.org/specification （Agentic AI Foundation〈Linux Foundation〉）
- ライセンス: スキーマのファイルには記載が無い。仕様の側の条件は取得元で確かめること

## 使い道

builtin `campaign-asset-upload`（`backend/control-plane/src/builtin/campaign-asset-upload.ts`）が、配布する Plugin の `plugin.json` を検証するのに使う。
読み先は**承認済みの `main` のチェックアウト**（ADR-18）で、作業ツリーのものは使わない。スキーマを更新するときは、取得元を取り直し、取得日を書き換えて PR を通す。
