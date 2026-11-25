# AGENTS.md

音声で SEO の BI を伝えるエージェント（comegin-seo-bi）。LiveKit Agents（Python）の上で、
会話は OpenAI GPT-Live、データは OpenSEO の MCP から読む。**セルフホストの SFU だけを使い、LiveKit Cloud は使わない。**
全体は `README.md`、設計は `docs/superpowers/specs/2026-11-21-voice-seo-bi-design.md`（契約は 9 節）。
リポジトリ全体の方針は、ルートの `.claude/CLAUDE.md` が上位にある。

## 守ること

- **テストを書かない・実行しない**（spec の U4）。確かめるのは静的検査（`uv run ruff check`・`uv run ruff format --check`）だけ。
  動作の確認は人が開発の環境で行う（計画の「検証（G-2）」）。
- **LiveKit の API を記憶で書かない。** livekit-docs の MCP（`docs_search`・`get_pages`・`code_search`）か、
  `.venv` に入った `livekit-agents` のソースで確かめてから書く。GPT-Live は `/agents/models/realtime/gpt-live`、
  MCP は `/agents/logic/tools/mcp` を読む。
- **LiveKit Cloud 前提の機能を使わない**: LiveKit Inference（`inference.*`・`"openai/gpt-live-1"` などの文字列の指定）、
  turn detector、適応型の割り込み判定、Cloud 認証の ai-coustics・Krisp、Agent Observability、シミュレーション、`lk agent` の Cloud 系のコマンド。
  モデルは OpenAI のプラグイン（`OPENAI_API_KEY`）、VAD はローカルの Silero を使う。
- **数値をでっち上げない。** 画面のカードはツールの実際の結果からだけ作る。モデルが数値を作って描くツールは作らない。
- **費用の出るツールを渡さない。** OpenSEO のツールは `openseo/allowlist.py` の許可リスト（無料の参照系）だけ。
- **秘密の値をログ・E-12 に出さない。** 設定の失敗は変数名と理由だけを出す。E-12 には個人情報・発話の全文・ツールの引数と結果の中身を書かない。
- コメント・ログ・文書は日本語で書く。

## GPT-Live の制約（設計を決めるもの）

- 音声専用。映像・画像は裏のモデルにも渡らない → 画面の読み取りは関数ツールで別のビジョンモデルに渡す（`vision/`）。
- ハンドオフすると新しいセッションになり、声も指示も途中で変えられない → エージェントは 1 体だけ（`SeoBiAgent`）。
  段階の切り替えは `duplex_session.append_thinking` / `append_commentary` とツールで行う（各 500 トークンまで）。
- 指示が 2 つに分かれる。声は `Agent.instructions`（`voice/persona.py`）、裏は `responses_options["instructions"]`（`bi/analyst.py`）。
  声のモデルはツールを見ないので、人格にツールの名前を書かない。
- 割り込みで止まるのは再生だけ。VAD を明示して渡さないと再生も止まらない（`voice/session.py`）。
- `generate_reply` は commentary として渡り、モデルが断ることがある（10 秒で話し始めなければ断ったとみなす）。`session.say` は使えない。

## 道具

- パッケージは `uv`。依存を足すときは `pyproject.toml` に書いて `uv sync`。有償の話者分離は optional（`--extra ai-coustics` / `--extra krisp`）。
- 整形と検査: `uv run ruff format` と `uv run ruff check`。
- 起動: `uv run src/agent.py dev`（開発）／ `uv run src/agent.py start`（常駐）。開発の SFU は `backend/livekit-system`。

## モジュールの担当

モジュールごとにフォルダを分けている（`src/comegin_voice/<モジュール>/`）。名前と型は spec の 9 節の契約に従い、変えるときは先に合わせる。
入口の `src/agent.py` は配線だけにし、処理は各モジュールに置く。
