# 音声 SEO BI エージェント（comegin-seo-bi）

Search Console と GA4 の数値を、SEO マーケターの視点で**音声で**伝える BI の担当者。
LiveKit Agents（Python）の上で、会話は OpenAI GPT-Live、データは OpenSEO の MCP（`http://127.0.0.1:3001/mcp`）から読む。

- 設計: `docs/superpowers/specs/2026-11-21-voice-seo-bi-design.md`（モジュール間の契約は 9 節）
- 計画: `docs/superpowers/plans/2026-11-21-voice-seo-bi.md`
- 決定: ADR-33（AA-05）。経路は I-34〜I-38

LiveKit Agents の Python スターター（`agent-starter-python`）から作り替えた。**LiveKit Cloud は使わない**（セルフホストの SFU だけ）。
そのため LiveKit Inference（Cloud 経由のモデル・turn detector・適応型の割り込み判定・Cloud の雑音抑制）・観測・シミュレーションは使えない。
スターターの `.github/`・`scenarios.yaml`・`Dockerfile` は Cloud 前提のまま残してあり、ここでは使わない。

## 何をするか

| | 内容 |
|---|---|
| W1（ブリーフィング） | 接続した直後に、計測の健全性・前の期間との比較・伸びしろを 3 点以内で話す。集計はコードが行い（`bi/briefing.py`）、モデルには事実だけを渡す |
| W2（質疑） | 問いに応じて、裏のモデルが OpenSEO の**無料の参照系のツールだけ**（許可リストは `openseo/allowlist.py`）を呼んで答える |
| 画面のカード | ツールの結果から作った表・グラフを、監視アプリの `/voice` に送る（topic `comegin.bi.card`）。数値は必ずツールの実際の結果 |
| 画面共有の読み取り | 聞かれたときだけ、画面共有（無ければカメラ）の最新の 1 フレームをビジョンモデルに渡す（`look_at_shared_screen`）。保存しない |
| 記録 | セッションの終わりに、問いの要約・使ったツール・結果 ID を E-12（`source: voice`）として `docs/audits/voice/` に書く |

数値をでっち上げない（ツールの結果に無い数字を話さない・描かない）、費用の出るツールを呼ばない、話を短く割り込めるようにする、を守る。

## 構成

```
src/agent.py                     入口。AgentServer・rtc_session(agent_name)・配線だけ
src/comegin_voice/
  config/settings.py             環境変数の検証（失敗時は変数名と理由だけを出して exit 1）
  voice/persona.py               声のモデル（GPT-Live）の指示
  voice/session.py               AgentSession（Silero VAD・割り込み）・RoomOptions・GPTLiveModel
  voice/audio_processing.py      音声強化（WebRTC の APM。ai-coustics・Krisp への切り替え）
  bi/                            状態・指標・ブリーフィング・裏のモデルの指示
  openseo/                       許可リスト・W1 用のクライアント・W2 用の MCPToolset
  vision/                        画面共有の最新フレームと look_at_shared_screen
  visual_output/cards.py         カードの型と送信
  observability/                 使用量のログと E-12 の書き出し
```

GPT-Live は指示が 2 つに分かれる。声のモデルは `voice/persona.py`（話し方・何を委ねるか）、
裏の Responses のモデルは `bi/analyst.py`（分析の手順・ツールの使い方）。どちらもセッションの途中では変えられない。

## 動かす（開発）

前提: [uv](https://docs.astral.sh/uv/)、Docker、OpenSEO が `127.0.0.1:3001` で動いていること（`onprem/systemd/comegin-openseo.service`）。

1. 開発の SFU を起動する（`livekit-server --dev`。`127.0.0.1:7880`、キーは公開の固定値 `devkey` / `secret`）。

   ```console
   cd backend/livekit-system
   docker compose up -d
   ```

2. 依存を入れ、環境変数を用意する。

   ```console
   cd backend/livekit-agent
   uv sync
   cp .env.example .env.local   # LIVEKIT_API_SECRET・OPENAI_API_KEY・VOICE_AUDIT_DIR を入れる
   ```

   setup（`node setup/setup.mjs --target dev --only livekit-agent`）を使うときは、`~/.config/comegin/setup/dev.conf` の `VOICE_OPENAI_API_KEY`（音声専用のキー）を書き込む。無ければ `OPENAI_API_KEY` で代用する。

3. OpenSEO に届くことを確かめる。

   ```console
   curl -s 127.0.0.1:3001/api/health
   ```

4. エージェントを起動する。**同じマシンで本番のユニットが動いているときは、先に止める**（ヘルスのポート 8081 が同じでぶつかる。2026-11-23 の決定。TA-01 の 9 節）。
   `sudo systemctl stop comegin-livekit-agent` で止め、確かめ終わったら `sudo systemctl start comegin-livekit-agent` で戻す。
   dispatch は明示（`agent_name="comegin-seo-bi"`）なので、部屋に入っただけでは来ない。
   監視アプリ（`frontend/next-js`。3200）の `/voice` から接続すると、トークンの `room_config` でこのエージェントが呼ばれる。

   ```console
   uv run src/agent.py dev
   ```

## 動かす（本番。オンプレの常駐）

- SFU は AWS の EC2（`cloud/stacks/livekit-sfu.yaml`）。起動と停止は人が `node cloud/livekit-sfu.mjs start|stop|status` で行う。
- エージェントはオンプレのホストで直接動かす（OpenSEO が `127.0.0.1` だけで受けるため、コンテナに入れない）。
  systemd のユニットは `onprem/systemd/comegin-livekit-agent.service`（`uv run src/agent.py start`）。
- ヘルスの HTTP は `127.0.0.1:8081`（開発の `uv run src/agent.py dev` と同じ番号。開発で動かすあいだは本番のユニットを止める）。
- OpenAI のキーは記事のアイキャッチ（監視アプリ）と分ける（2026-11-23。ADR-33）。OpenAI の画面でプロジェクトを分けて発行し、`prod.conf` の `VOICE_OPENAI_API_KEY` に書く（setup が環境変数ファイルの `OPENAI_API_KEY` に写す）。
- SFU を 3 時間以上起動したままにすると、SNS の `ops` に止め忘れの通知が来る（`stacks/livekit-sfu.yaml` の `RunningTooLongAlarm`）。
- SFU が止まっている間、エージェントは接続を再試行し続ける。ログは出るが、異常ではない。

## 環境変数

雛形は `.env.example`。検証は `src/comegin_voice/config/settings.py`。

| 変数 | 必須 | 既定 | 内容 |
|---|---|---|---|
| `LIVEKIT_URL` | ○ | | SFU の URL（`ws://` か `wss://`）。開発は `ws://127.0.0.1:7880` |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | ○ | | SFU の API キーとシークレット |
| `OPENAI_API_KEY` | ○ | | GPT-Live・裏のモデル・ビジョン。**音声専用のキー**（アイキャッチと分ける。setup では `VOICE_OPENAI_API_KEY` から写す） |
| `LIVEKIT_AGENT_NAME` | | `comegin-seo-bi` | dispatch の名前。監視アプリと同じ値にする |
| `OPENSEO_MCP_URL` | | `http://127.0.0.1:3001/mcp` | ループバックだけを指定できる |
| `OPENSEO_PROJECT_DOMAIN` | | `comegin.com` | OpenSEO のプロジェクトを選ぶドメイン（0 件・複数件なら縮退） |
| `GPT_LIVE_VOICE` | | `marin` | 声 |
| `BACKEND_MODEL` / `VISION_MODEL` | | `gpt-5.6-luna` | 裏の Responses のモデル／画面の読み取りのモデル |
| `SESSION_MAX_MINUTES` | | `30` | 1 セッションの上限（分） |
| `MAX_TOOL_CALLS` | | `40` | 1 セッションで OpenSEO を呼ぶ回数の上限 |
| `MAX_VISION_CALLS` | | `10` | 1 セッションで画面を読む（ビジョンモデルを呼ぶ）回数の上限 |
| `VOICE_AUDIT_DIR` | | （空） | E-12 の書き先（監視アプリの作業ツリーの `docs/audits/voice` の絶対パス）。空なら書かない |
| `AUDIO_ENHANCEMENT` | | `apm` | `apm` / `off` / `ai_coustics` / `krisp` |

## ノイズと割り込み

| 機能 | どこで | 方法 |
|---|---|---|
| ターンの切れ目 | モデル | GPT-Live が全二重で自分で決める（LiveKit の turn detector は使えない・効かない） |
| 割り込みで再生を止める | エージェント | ローカルの Silero VAD（`vad` モード、0.5 秒以上の発話）。止まるのは再生だけで、モデルは話し続けた内容も覚えている。人格の指示で「言い直さず短く確認する」にしている |
| エコー除去 | ブラウザ | `echoCancellation: true`（再生する音が要るので、サーバー側ではできない） |
| 雑音抑制・低い音のカット | エージェント | `AUDIO_ENHANCEMENT=apm`。WebRTC の APM を `FrameProcessor` に包み、50 ms のフレームを 10 ms ずつ処理する。音量の自動調整はフレームワークの AGC。ブラウザの `noiseSuppression`・`autoGainControl` は切る（二重にかけない） |
| 話者分離 | エージェント | 有償。`ai_coustics`（`uv sync --extra ai-coustics`、`AI_COUSTICS_API_KEY`）か `krisp`（`uv sync --extra krisp`、`KRISP_VIVA_SDK_LICENSE_KEY`・`KRISP_VIVA_FILTER_MODEL_PATH`）。無いときは起動時に止まる |

## 縮退

- OpenSEO に届かない・プロジェクトが決まらない: その旨を一度だけ話し、W1 を出さない。OpenSEO のツールは渡さない（画面の読み取りだけ）。数値は推測しない。
- 途中でツールが失敗した: 一度だけそう伝え、別の見方を提案する。
- 上限: 30 分（1 分前に締めくくりを促す）、無発話 2 分で一度だけ確認し、30 秒で閉じる。閉じると部屋を消す。

## 既知の制約

- **OpenSEO を再起動したら、音声のセッションを開始し直す。** 会話中に OpenSEO が再起動すると、W2 の MCP の接続（`MCPServerHTTP`）は張り直されない。以後の質疑はツールのエラー（上流の英語の文）を返すだけになり、台帳（E-12 の結果 ID）にも残らない。縮退として受け入れている。

## 依存を上げるとき

- `livekit-agents` は `~=1.8.8`（1.8.x の中）に固定している。上げるときは、`openseo/toolset.py` の `_call_tool` の上書き
  （許可リストと呼び出し回数の上限をかける場所）が、新しい版の `MCPServerHTTP` でもまだ呼ばれるかを確かめる。
  呼ばれなくなると、許可リストの外のツールや上限を超えた呼び出しが黙って通る。
- `[tool.uv]` の `exclude-newer`（公開から 7 日の待ち期間）の日付を、上げる日の 7 日前に進めてから `uv lock` する。
- 上げたら、`.venv` のソースで GPT-Live・`AudioInputOptions`・`TurnHandlingOptions` の引数が変わっていないかを確かめる。

## 静的検査

テストは書かない・実行しない（spec の U4）。静的検査だけを行う。

```console
uv run ruff check
uv run ruff format --check
```
