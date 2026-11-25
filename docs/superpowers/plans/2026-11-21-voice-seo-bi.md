# 音声 SEO BI エージェント（LiveKit セルフホスト × GPT-Live × OpenSEO MCP）（Agent teams 実行用）

> 設計: `docs/superpowers/specs/2026-11-21-voice-seo-bi-design.md`（Wave 0 の確認の結果は spec の 4 節）。作成: 2026-11-21

## Context

- **何をするか**: `backend/livekit-agent`（LiveKit Agents の Python スターター。コミット 62a08654 で取り込んだだけで未改変）を、SEO の BI を音声で伝える担当者に作り替える。データは OpenSEO の MCP（`http://127.0.0.1:3001/mcp`。GSC・GA4 を中継）から読む。
- **ワークフロー**:
  - **W1（ブリーフィング）**: 接続した直後に、GSC・GA4 の要点を BI として話す。
  - **W2（質疑）**: ユーザーの質問に応じて、OpenSEO の MCP ツールを呼んで答える。
- **なぜ必要か**: 夜の観測（analytics-reporter・seo-auditor）が E-12 に数値を残している。しかし人がそれを対話で読み解く入口は無い。TA-07 の 3.2 の「数値」の構想と、CAP-01（KPI 管理。`未配線`）がこれに当たる。
- **再帰的自己改善との関係**: 対話で出た問いと結論を E-12 に残す。proposal-writer がそれを E-13 の根拠に使えるようにして、ループに戻す。

### 調べて分かった制約（設計を決めるもの）

| # | 事実 | 出典 | 設計への影響 |
|---|---|---|---|
| C1 | GPT-Live は**音声専用**。映像・画像の入力を受け付けない。`video_input=True` にしてもフレームは黙って捨てられる | livekit-docs `/agents/models/realtime/gpt-live` | 映像の理解は**ツールで別のビジョンモデルに渡す**（後述 M3） |
| C2 | GPT-Live は**ハンドオフすると新しいセッションになる**（声も指示も途中で変えられない）。ツールだけは同じ接続のまま差し替えられる | 同上 | 音声エージェントは **1 体**にする。段階（ブリーフィング→質疑）は、ツールと文脈の追記（`append_thinking` / `append_commentary`）で切り替える |
| C3 | 指示が 2 つに分かれる。声のモデルは `Agent.instructions`、推論とツールを担う裏のモデルは `responses_options.instructions` | 同上 | 「話し方」と「SEO マーケターの分析手順」を別のモジュールに置く |
| C4 | セルフホスト（LiveKit OSS）では **LiveKit Inference が使えない**。そのため Krisp・ai-coustics（Cloud 経由）、適応型の割り込み判定、turn detector のフルモデルも使えない | `/transport/self-hosting` | OpenAI のプラグイン（`openai.realtime.GPTLiveModel`。`OPENAI_API_KEY`）と、ローカルで動く Silero VAD を使う |
| C5 | GPT-Live では、ターンの切れ目と割り込み（barge-in）をモデル自身が決める。再生を止めるには、**VAD を明示的に渡す必要がある**（このモデルではセッション既定の VAD が外れる） | 同上 | `AgentSession(vad=silero.VAD.load())` |
| C6 | OpenSEO は `local_noauth`。Host が localhost 系でないと 403 を返し、`127.0.0.1:3001` だけに公開されている。host-relay は `/mcp` を通さない | `middleware/open-seo-main/src/server/mcp/transport.ts`、`middleware/host-relay/README.md` | エージェントは**コンテナに入れず、オンプレのホストで直接**（systemd＋uv で）動かす |
| C7 | OpenSEO の費用は description の文言（`Charges credits`）で決まる。GSC・GA4 のツールはすべて無料 | `src/server/mcp/tools/*.ts`、AA-03 の 2.4 | 許可リストを**無料の参照系だけ**にする。そうすれば DataForSEO の費用は 0 になる |
| C8 | ブラウザから SFU へ UDP で直接届く必要があり、ngrok では中継できない | `/transport/self-hosting/ports-firewall` | SFU は EC2 に置く（U1） |

## ユーザーの決定

| ID | 決定 |
|---|---|
| U1 | LiveKit サーバー（SFU）は **AWS の EC2** に置く。オンプレのエージェントは wss で外向きに接続する（ADR-21 の「AWS→オンプレは n8n の Webhook だけ」を崩さない） |
| U2 | 画面は**監視アプリ（`frontend/next-js`）に `/voice` を足す**。Google ログインと許可リストはそのまま使う |
| U3 | ノイズ対策は**ブラウザの WebRTC を基本**にし、加えて**サーバー（エージェント）側で無料でできる範囲を組み込む**（下の補足）。話者分離は有償のライセンスが要るので、切り替えの口だけ用意する |
| U4 | **テストは書かない・実行しない**（ruff・typecheck・cfn-lint などの静的検査だけ） |
| U5 | 実時間のモデルは **OpenAI GPT-Live**。マルチモーダルに対応し、割り込みとノイズを適切に扱う |
| U6 | SFU の EC2 は **Auto Scaling グループ**に入れ、**起動と停止は人が手で行う**（希望する台数を 0 と 1 で切り替える） |
| U7 | フロントエンドは **LiveKit Components React**（`@livekit/components-react`・`@livekit/components-styles`・`livekit-client`）で作る |

### U3 への補足（ターン検出・音声強化・話者分離をどこで行うか）

| 機能 | どこで | 方法 | 費用 |
|---|---|---|---|
| ターン検出 | モデル | GPT-Live が全二重で自分で判定する。LiveKit の turn detector は GPT-Live の判定を変えられず、セルフホストでは Cloud の認証も要るので使わない | 0 |
| 割り込みでの再生停止 | エージェント | ローカルの Silero VAD（CPU） | 0 |
| エコー除去 | ブラウザ | `echoCancellation: true`。エコー除去には再生する音が要るため、サーバー側では行えない | 0 |
| 音声強化（雑音の抑制・低い音のカット・音量の自動調整） | **エージェント** | `rtc.AudioProcessingModule`（WebRTC の APM。`noise_suppression`・`high_pass_filter`・`auto_gain_control`）を自作の `rtc.FrameProcessor[AudioFrame]` に包み、`AudioInputOptions(noise_cancellation=...)` に渡す。APM は 10 ms ずつしか処理しないので、フレームを切り分ける。抑制を二重にかけないよう、ブラウザの `noiseSuppression`・`autoGainControl` は切る | 0 |
| 話者分離（他人の声を消す） | エージェント | 無料の手段は無い。有償のどちらかで、どちらもセルフホストで動く。(a) ai-coustics Voice Focus（`audio_enhancement(model=QUAIL_VF_S, auth=Auth.ai_coustics_api(license_key=...))`） (b) Krisp VIVA（`krisp.auth.krisp_license(license_key=..., model_path=*.kef)`） | 契約が要る |

- 切り替えは `AUDIO_ENHANCEMENT=apm|off|ai_coustics|krisp` で行う（既定は `apm`）。ai-coustics・Krisp のプラグインは、使うときだけ optional の依存として入れる。
- APM の `FrameProcessor` が `noise_cancellation` に渡せることは、Krisp VIVA が同じ型（`rtc.FrameProcessor[rtc.AudioFrame]`）であることから見込んでいる。**Wave 0 で確かめる。**

### 「裏のモデルで映像・画像を処理できるか」への答え

- **できない。** GPT-Live のプラグインは音声専用で、「裏のモデルが画像に対応していても、画像は渡せない」と明記されている（livekit-docs `/agents/models/realtime/gpt-live` の Overview）。
- そのため、ツール `look_at_shared_screen` が画面共有のフレームを**別のビジョンモデルに直接渡し**、その結果（文字の事実）を裏のモデルに返す（D5）。
- 映像をモデルに直接流せるのは OpenAI Realtime API（gpt-realtime。`video_input=True`、プラグインのときだけ）か Gemini Live で、GPT-Live ではない。
- **U8（ユーザーの決定）**: 会話は GPT-Live のままにする。映像は**聞かれたときだけ**、最新の 1 フレームを OpenAI Responses のビジョンモデルに渡す（gpt-realtime で映像を常に見る形と、全体を gpt-realtime にする形は採らない）。

## 計画の側で決めたこと

| ID | 決定 | 理由 |
|---|---|---|
| D1 | 音声エージェントは 1 体（`SeoBiAgent`）。W1 は**コード**で集計し、モデルには事実だけを渡す。W2 はモデルが MCP ツールを呼ぶ | C2。数値の比較は「状態はコードが持つ」。W1 の 5〜6 本の呼び出しを並列にして、待ち時間を短くする |
| D2 | MCP は `mcp.MCPToolset(MCPServerHTTP(..., allowed_tools=[...], tool_result_resolver=...))` で渡す。projectId はセッションの開始時にコードで決める（`list_projects` で `comegin.com`）。裏のモデルの指示にその projectId を書き込む | LiveKit の MCP の正式な機能。費用の出るツールを登録しない（ADR-10 の決定 2 と同じ考え方） |
| D3 | **許可リスト（無料の参照系だけ）**: `get_search_console_performance`・`inspect_urls`・`get_google_analytics_organic_overview`・`get_google_analytics_organic_landing_pages`・`get_google_analytics_page_performance`・`get_google_analytics_traffic_acquisition`・`get_google_analytics_key_events`・`get_google_analytics_audience_breakdown`・`get_google_analytics_measurement_health`・`get_search_opportunities`・`get_project_context`。書き込み系（`save_keywords`・`update_project_context`・`create_*`）と有料のツールは載せない | C7。参照だけにすれば、承認ゲート（BA-05）に触れない |
| D4 | **画面への出力（マルチモーダルの出力）**: MCP の結果は、resolver が 2 つに分けて扱う。モデルには圧縮した事実の JSON を返す。画面にはカード（表・折れ線・棒）を text stream で送る（topic `comegin.bi.card`）。モデルが数値を作って描くツールは**作らない** | 画面に出る数値は、すべてツールの実際の結果になる（でっち上げを防ぐ） |
| D5 | **映像の入力（マルチモーダルの入力）**: 関数ツール `look_at_shared_screen(question)` を作る。画面共有（無ければカメラ）の最新フレームを JPEG（1024 に収める）にして、OpenAI Responses のビジョンモデルに渡し、事実を返す。フレームは保存しない | C1 の回避。GA4・GSC の画面や SERP を共有して「このグラフはなぜ落ちた？」と聞く使い方を想定 |
| D6 | テキスト入力（画面のチャット欄）も受ける。**Wave 0 で確認済み**: 既定のテキスト入力の処理（`generate_reply(user_input=...)`）が、GPT-Live では commentary として渡る | spec の 4 節 (b) |
| D7 | 割り込みの設定: `vad=silero.VAD.load()`、`TurnHandlingOptions` の interruption は `vad` モード、`min_interruption_duration` は 0.5 秒前後。**Wave 0 で確認済み**: 止まるのは再生だけで、モデルは話し続け、聞かせていない部分も覚えている。`resume_false_interruption` が効くかは G-2 でログを見て確かめ、効かなければ外す。人格の指示に「割り込まれたら、言い直さず短く確認する」を入れる | C5、spec の 4 節 (c) |
| D8 | SFU は Auto Scaling グループ（`cloud/stacks/livekit-sfu.yaml`）に置く。中身は D8a〜D8e | U1・U6。UDP のポートの範囲を扱うため、ECS ではなく EC2 にする（ADR-26 の例外。前例は WireGuard の EC2〈`stacks/wireguard.yaml`〉の書き方） |
| D8a | **起動テンプレート**: AL2023 の arm64。型は既定で `t4g.small`（パラメータにする）。IMDSv2 を必須にし、ルートボリュームを暗号化する。運用は SSM Session Manager で行い、22 番は開けない。user data で docker・`livekit-server`・Caddy を入れる。`livekit.yaml` の API キーとシークレットは、起動のたびに SSM の SecureString から読む | wireguard.yaml と同じ流儀 |
| D8b | **ASG**: `MinSize: 0`、`MaxSize: 1`。`DesiredCapacity` は**テンプレートに書かない**。書くと、作成時の値（0）にデプロイのたびに戻され、手で起動した SFU が止まるおそれがある。public サブネットに置く | AWS のドキュメントでは、DesiredCapacity は作成時の初期値 |
| D8c | **warm pool**（ユーザーが「インスタンスを削除しない停止」に決定）: `PoolState: Stopped`、`InstanceReusePolicy.ReuseOnScaleIn: true`。停止（希望 0）ではインスタンスを消さずに止め、起動（希望 1）ではそれを開始する。EBS が残るので、Caddy の TLS 証明書を毎回取り直さない（Let's Encrypt の週 5 回の制限を避ける）。起動も速い。**Wave 0 で確認済み**: user data は最初の 1 回しか動かない。`EC2_INSTANCE_LAUNCHING` のライフサイクルフック（600 秒、既定の動作は ABANDON）を置き、起動のたびに systemd の oneshot が次の 3 つを行う: EIP の付け替え → SSM から `livekit.yaml` を作る → `complete-lifecycle-action CONTINUE`。ロールには、この ASG の `CompleteLifecycleAction` を許す | 停止のたびにインスタンスを作り直すと、証明書の取り直しと起動の遅れが毎回起こる。spec の 4 節 (h) |
| D8d | **Elastic IP**: スタックで 1 つ確保する。起動するたびに、systemd の oneshot が `ec2:AssociateAddress --allow-reassociation` で付け直す（同じ処理を何度しても結果は変わらない）。インスタンスロールに許す操作は、この割り当て ID の付け替えと、SSM のパラメータを読むことだけ。DNS は `rtc.comegin.com`（シグナリングの wss）と `rtc-turn.comegin.com`（TURN/TLS）を EIP に向ける。DNS の置き場は `cloud/` の既存の流儀に合わせる | ASG では ENI を固定できないため |
| D8e | **SG**: 80/tcp（証明書の取得）・443/tcp（wss と TURN/TLS。Caddy が SNI で振り分ける）・7881/tcp・3478/udp・50000-60000/udp だけを開ける。1 台なので Redis は持たない。複数台にするときは ElastiCache を使う（6379 は Chatwoot の開発で使っているので、開発で衝突させない） | LiveKit の VM での構成（`/transport/self-hosting/vm`）に合わせる |
| D8f | **起動・停止の手順**: `cloud/livekit-sfu.mjs start|stop|status` を作る（日本語のヘルプ付き）。`set-desired-capacity` を呼び、InService になったら `https://rtc.comegin.com` に届くことを確かめる。**実行するのは人で、Claude は実行しない。** 止めている間も費用がかかるのは EBS と EIP（パブリック IPv4 の時間課金）。監視アプリの `/voice` は、SFU に届かないとき「SFU が停止中」と表示する | U6 |
| D9 | 開発の SFU: `backend/livekit-system/` に `livekit-server --dev` の compose を置く（`127.0.0.1` に 7880・7881・7882/udp）。本番の EC2 用の設定の雛形も同じ場所に置く | 命名規則 `<プロダクト>-system`。オンプレの開発機でブラウザとエージェントを完結させる |
| D10 | エージェントのオンプレでの常駐: `onprem/systemd/comegin-livekit-agent.service`（`Type=simple`、`uv run src/agent.py start`、`Restart=on-failure`、`Requires=` は付けない）。ヘルスのポートは 8081（127.0.0.1）。dispatch は明示で、`agent_name="comegin-seo-bi"` | C6。`comegin-control` と同じ型 |
| D11 | セッションの上限: 30 分で自動で閉じる。無発話は `user_away_timeout` で閉じる。MCP の呼び出しは 1 セッション 40 回まで（コードで数える）。終了時に `session.usage` をログに出す | GPT-Live はセッションの時間で課金され、GA4 の Data API には割り当てがある |
| D12 | **改善ループへの接続**: セッションの終わりに、問い・使ったツール・伝えた結論（数値は結果 ID で参照）を E-12（`source: voice`）として `docs/audits/voice/AUD-*.md` に書く。置き場は監視アプリの作業場と同じ規則に合わせる（`backend/control-plane` の E-12 の置き場を確かめる）。音声と映像は残さない | 再帰的自己改善。人が何を気にしたかは、proposal-writer の起票前チェックの根拠になる |
| D13 | 新しい ID: **ADR-33**、**I-34〜I-38**（監視アプリ→トークン、ブラウザ⇄SFU、エージェント⇄SFU、エージェント→OpenSEO、エージェント→OpenAI）。CAP は新設せず、**CAP-01 に追記**する | 採番の正本は README の「ID の採番と正本」。README の索引の更新漏れ（ADR-28・I-30 のまま）も同時に直す |

## モジュール構成（「モジュールごとにフォルダ」）

```
backend/livekit-agent/                 # 自作（エージェント）。pyproject の name を comegin-livekit-agent に
  src/agent.py                         # 入口: AgentServer・rtc_session(agent_name)・各モジュールの配線だけ
  src/comegin_voice/
    config/settings.py                 # 環境変数を検証する。失敗時は「変数名と理由だけ」を出して exit(1)（MCP サーバーの config.ts と同じ方針）
    voice/persona.py                   # 声のモデルの指示（日本語・ですます・短く・数字の読み方・委ねる範囲）
    voice/session.py                   # AgentSession・GPTLiveModel・Silero VAD・TurnHandling・RoomOptions・上限
    voice/audio_processing.py          # U3: APM の FrameProcessor（10 ms に切り分ける）と、AUDIO_ENHANCEMENT での切り替え（apm|off|ai_coustics|krisp）
    bi/analyst.py                      # 裏のモデルの指示（SEO マーケターの分析手順。後述）
    bi/briefing.py                     # W1: 並列で MCP を呼び、指標を計算し、事実と画面のカードを作る
    bi/metrics.py                      # 純粋関数: 期間の比較・順位 4〜20 位で表示回数が多い語・掲載順位に比べて低い CTR・CVR
    bi/state.py                        # BiSessionState（projectId・期間・結果の台帳・カード ID・呼び出し回数）。1 セッションに 1 つ
    openseo/allowlist.py               # D3 の許可リストと、載せない理由のコメント
    openseo/client.py                  # W1 用の MCP クライアント（call_tool・projectId の解決・タイムアウト・縮退）
    openseo/toolset.py                 # W2 用の MCPToolset・tool_result_resolver（圧縮・カードの送信・回数の上限）
    vision/frames.py                   # 画面共有・カメラの最新フレームを持つ（保存しない）
    vision/tools.py                    # look_at_shared_screen（OpenAI Responses のビジョン）
    visual_output/cards.py             # カードの型（pydantic）と text stream での送信
    observability/session_log.py       # usage・ツールの呼び出しの要約（stderr の構造化ログ）
    observability/audit.py             # D12 の E-12 の書き出し
  setup/index.mjs                      # setup の契約（setup/lib/core.mjs）。uv sync と環境変数ファイル（例: consent-api の setup）
  .env.example / README.md / AGENTS.md # セルフホストの前提に書き直す
backend/livekit-system/                # 開発の SFU の compose と、本番の EC2 の livekit.yaml・Caddyfile の雛形
frontend/next-js/                      # U7: LiveKit Components React で作る
  app/(console)/voice/page.tsx         # requirePageSession で守る。LiveKit の部品は 'use client' のコンポーネントに閉じ込める
  app/api/livekit/token/route.ts       # guardApiRequest。TokenSource.endpoint の標準の要求・応答の形に合わせる。identity はメール、ルームは voice-<uuid>、TTL は 10 分、room_config で agent_name を dispatch
  components/voice/VoiceSession.tsx    # useSession(TokenSource.endpoint('/api/livekit/token'), { agentName }) と SessionProvider・RoomAudioRenderer
  components/voice/AgentPanel.tsx      # useAgent・BarVisualizer（状態: 聞いている・考えている・話している）
  components/voice/MediaControls.tsx   # ControlBar か TrackToggle（マイク・カメラ・画面共有）。マイクの AudioCaptureOptions は echoCancellation だけ true（U3）
  components/voice/TranscriptPanel.tsx # 文字起こし（useTranscriptions など。版で名前を確かめる）
  components/voice/BiCardList.tsx      # useTextStream('comegin.bi.card') で受けて、カードを描く（グラフは既存の Cloudscape）
  lib/livekit/*                        # カードの型（エージェント側の cards.py と同じ形）
cloud/stacks/livekit-sfu.yaml          # D8: 起動テンプレート・ASG・warm pool・EIP・SG・SSM・ロール・DNS（template.yaml に入れ子で足す）
cloud/livekit-sfu.mjs                  # D8f: 手で起動・停止する（start|stop|status）
onprem/systemd/comegin-livekit-agent.service
```

### モジュール間の契約（Wave 0 で spec に固定する）

- **カードの型**（`visual_output/cards.py` ⇔ `lib/livekit/cards.ts`）: `{ v: 1, id, kind: "kpi"|"table"|"line"|"bar", title, period: {start, end, compare?}, source_tool, result_id, data }`。topic は `comegin.bi.card`。
- **環境変数（エージェント）**: `LIVEKIT_URL`・`LIVEKIT_API_KEY`・`LIVEKIT_API_SECRET`・`OPENAI_API_KEY`・`OPENSEO_MCP_URL`（既定 `http://127.0.0.1:3001/mcp`）・`OPENSEO_PROJECT_DOMAIN`（既定 `comegin.com`）・`GPT_LIVE_VOICE`・`BACKEND_MODEL`・`VISION_MODEL`・`SESSION_MAX_MINUTES`・`VOICE_AUDIT_DIR`・`AUDIO_ENHANCEMENT`（既定は `apm`）。ai-coustics・Krisp を使うときだけ、それぞれのライセンスの変数を足す
- **環境変数（監視アプリ）**: `LIVEKIT_URL`（ブラウザが使う wss）・`LIVEKIT_API_KEY`・`LIVEKIT_API_SECRET`・`LIVEKIT_AGENT_NAME`
- **ポート**: 7880・7881・7882/udp（開発の SFU。127.0.0.1）、8081（エージェントのヘルス。127.0.0.1）。本番の EC2 では 80・443・7881/tcp と 3478/udp・50000-60000/udp

### SEO マーケターの視点（`bi/analyst.py` と `bi/briefing.py` に入れる手順）

1. **計測の健全性を先に見る**（`measurement_health`）。問題があれば、数値の解釈より先にそれを伝える。
2. **常に前の期間と比べる**。ただし次の注意を添える。
   - GSC は 2〜3 日遅れ、日付は太平洋時間。
   - GA4 は直近 28 日の確定分。
   - 季節性・曜日の偏り。
3. **伸びしろの順に並べる**。
   - 順位 4〜20 位で表示回数が多いクエリ（あと一歩で上位に届く語）
   - 掲載順位に比べて CTR が低いページ（タイトル・ディスクリプションの改善）
   - 自然検索の流入はあるのにキーイベントが少ない LP（CVR の改善）
   - 1 つのクエリに複数のページが出ているもの（カニバリゼーション）
   - インデックスの問題（`inspect_urls`）
4. **話すのは 3 点まで**。各点を「事実 → 解釈 → 次の一手」の順で話す。次の一手は、改善ループのどれに回せるかで言う（記事の改稿・キーワード調査・技術の修正）。エージェントは E-13 を起票しない（起票は proposal-writer の役目）。
5. **分からないことは分からないと言う**。ツールが失敗したら一度だけそう伝え、代わりの見方を提案する。数値を推測で言わない。

## チーム構成

前提: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`。

| 名前 | 担当 | 書き込んでよい範囲 | plan approval |
|---|---|---|---|
| lead | Wave 0・統合・ゲート・最終レビュー | `docs/superpowers/`・全体の調整 | — |
| agent-core | 音声のセッション・人格・設定・配線 | `backend/livekit-agent/src/agent.py`・`config/`・`voice/`・`observability/`・`pyproject.toml`・README・AGENTS.md・`.env.example` | 要 |
| seo-bi | OpenSEO の接続・BI の集計・マーケターの手順・カードの生成 | `src/comegin_voice/openseo/`・`bi/`・`visual_output/` | 要 |
| multimodal | 映像の理解と画面 | `src/comegin_voice/vision/`・`frontend/next-js/`（voice・token・lib/livekit・ナビ） | 要 |
| infra | SFU（開発・本番）・常駐・setup | `backend/livekit-system/`・`cloud/`・`onprem/systemd/`・`backend/livekit-agent/setup/`・`setup/setup.mjs` の MODULES | 要 |
| docs | ADR と 4 層の文書 | `docs/RequirementDefinition/`・`docs/README.md`・`.claude/CLAUDE.md`・`onprem/README.md`・`cloud/README.md` | 不要 |

## Global Constraints（全員）

- テストを書かない・実行しない（U4）。静的検査は行ってよい: `uv run ruff check` / `ruff format --check`、`pnpm typecheck`、cfn-lint・`sam validate --lint`。
- ビルド（`pnpm build`・`sam build`）、デプロイ、状態を変える git の操作をしない。`.env` を読まない。
- LiveKit の API は記憶で書かない。`reading-livekit-docs` のスキルと livekit-docs MCP で確かめてから書く。Next.js 16.3.5 は `node_modules/next/dist/docs/` を先に読む。
- pnpm 11 のポリシー（minimumReleaseAge など）に従って依存を足す。Python は uv の `.venv` だけを使う。
- 文書・コメント・ログは日本語で書く。秘密の値をログに出さない（変数名だけ）。

## Wave とタスク

| ID | 担当 | 内容 | 依存 |
|---|---|---|---|
| **Wave 0** | | | |
| W0-1 ✅ | lead | **2026-11-21 に済み（結果は spec の 4 節）。** 確かめる（docs と `code_search`）: (a) `MCPToolset` が GPT-Live の responses delegation で呼ばれるか (b) GPT-Live がテキストのユーザー入力を受けるか（D6） (c) duplex のときに VAD の割り込みの設定が効くか（D7） (d) APM を包んだ `rtc.FrameProcessor` が `AudioInputOptions.noise_cancellation` に渡せるか、フレームの長さ (e) livekit-server の開発用 docker の起動方法 (f) control-plane の E-12 の置き場 (g) `TokenSource.endpoint` の要求・応答の形と、`@livekit/components-react` の今の版のフック名（`useSession`・`useAgent`・`useTextStream`・文字起こし） (h) warm pool から起動したとき user data が動かないこと。起動のたびの処理（EIP・キー）は systemd に置く。結果を spec に書く | — |
| W0-2 ✅ | lead | **2026-11-21 に済み。** spec `docs/superpowers/specs/2026-11-21-voice-seo-bi-design.md`（意図・目標・非目標・制約・契約・作る人に任せること）を書き、この計画を `docs/superpowers/plans/2026-11-21-voice-seo-bi.md` に写す | W0-1 |
| **G-1** | user | spec を承認する（特に W0-1 の (a)〜(c) の結果で D2・D6・D7 を変える場合） | W0-2 |
| **Wave 1**（並列） | | | |
| A1 | agent-core | `config/`・`voice/`（GPTLiveModel・Silero・TurnHandling・RoomOptions〈`video_input` は使わない〉・`audio_processing.py`）・`agent.py` の骨組み・pyproject（`livekit-agents[openai,mcp,silero]~=1.8`。ai-coustics・Krisp は optional の依存に移す） | G-1 |
| B1 | seo-bi | `openseo/allowlist.py`・`client.py`（projectId の解決・タイムアウト・OpenSEO が落ちたときの縮退）・`bi/metrics.py`・`bi/state.py`・`visual_output/cards.py` | G-1 |
| C1 | multimodal | `pnpm add @livekit/components-react @livekit/components-styles livekit-client livekit-server-sdk`。トークンの API ルート・`/voice` の骨組み（`VoiceSession`・`AgentPanel`・`MediaControls`・`TranscriptPanel`）・ナビへの追加。`@livekit/components-styles` の CSS が Cloudscape とぶつからないよう、`/voice` の中に閉じ込める | G-1 |
| D1 | infra | `backend/livekit-system/`（開発の compose）・`backend/livekit-agent/setup/index.mjs`・setup.mjs への登録 | G-1 |
| E1 | docs | ADR-33 の下書き（U1〜U5・D1〜D13。リスク受容: 音声が OpenAI〈米国〉に渡る、OpenSEO の接続元が増える〈ADR-10 の決定 1・2 の改訂〉） | G-1 |
| **Wave 2** | | | |
| A2 | agent-core | 配線: セッション開始 → projectId の解決 → 指示の組み立て → W1 の結果を `append_thinking` で渡す → `generate_reply` で話し始める。上限・usage・終了時の処理 | A1・B2 |
| B2 | seo-bi | `bi/briefing.py`（並列で呼び、指標を計算し、カードを作る）・`openseo/toolset.py`（resolver: 圧縮・カードの送信・回数の上限）・`bi/analyst.py` | B1 |
| C2 | multimodal | `vision/`（フレームの保持と `look_at_shared_screen`）・`BiCardList`（Cloudscape のグラフ）・カメラと画面共有のボタン | C1・B1（カードの型） |
| D2 | infra | `cloud/stacks/livekit-sfu.yaml`（D8a〜D8e）と `template.yaml` への入れ子の追加・`cloud/livekit-sfu.mjs`（D8f）・`livekit.yaml` と Caddyfile（SNI で wss と TURN/TLS を振り分け）の雛形・`onprem/systemd/comegin-livekit-agent.service` | D1 |
| E2 | docs | AA-01・AA-02（I-34〜38）・AA-03 の 2.4・BA-02（CAP-01 への追記）・TA-01（ポート・配置）・TA-06（EC2）・TA-07（常駐）・`.claude/CLAUDE.md`（ポート表・自作コードの表）・README の索引の更新漏れ | E1 |
| **Wave 3**（統合） | | | |
| L3-1 | lead | 静的検査（ruff・typecheck・cfn-lint）。`code-reviewer` のサブエージェントでレビューする（観点: 状態の持ち方、費用の出るツールが紛れ込んでいないか、秘密の値の扱い、ツールが失敗したときの話し方） | Wave 2 |
| L3-2 | infra＋agent-core | D12 の E-12 の書き出し（`observability/audit.py`）と、TA-05 の監視への追記 | A2 |
| **G-2** | user | 開発で手で確かめる（下の「検証」） | L3-1 |
| **Wave 4**（本番。人の承認ごと） | | | |
| P4-1 | user | `cloud/` の SFU を deploy する（作られた直後は希望が 0 なので、warm pool に止まったインスタンスが 1 台だけある）。DNS とキーを用意し、`node cloud/livekit-sfu.mjs start` で起動する（Claude はデプロイも起動もしない） | G-2 |
| P4-2 | user | オンプレに systemd のユニットを置き、`systemctl enable --now` する。監視アプリの本番の環境変数を足す | P4-1 |
| **G-3** | user | 本番の SFU を通して動作を確かめる | P4-2 |

## 検証（G-2。テストコードは作らない）

1. `cd backend/livekit-system && docker compose up -d`（開発の SFU）→ `cd backend/livekit-agent && uv run src/agent.py dev`
2. OpenSEO が動いていることを確かめる（`curl -s 127.0.0.1:3001/api/health`）。監視アプリ `pnpm dev`（3200）→ `/voice` で接続する。
3. 確かめること:
   - **W1**: 30 秒以内に、日本語で 3 点以内のブリーフィングがある。画面にカードが出て、数値が OpenSEO の結果と一致する。
   - **W2**: 「先月と比べてクリックが落ちたページは？」「順位 4〜20 位で表示が多い語は？」で、許可リストのツールだけが呼ばれる（ログで確かめる）。
   - **割り込み**: エージェントが話している途中で話しかけると再生が止まる。相づちでは止まらない。
   - **ノイズ**: `AUDIO_ENHANCEMENT=apm` と `off` を切り替えて、雑音のある環境での誤った割り込みが減ることを聞き比べる。
   - **起動と停止（G-3）**: `livekit-sfu.mjs stop` → status で warm pool の Stopped を確かめる。`start` → InService になり、EIP と証明書がそのままで接続できる。
   - **映像**: GA4 の画面を共有して「このグラフの谷は何？」と聞くと、`look_at_shared_screen` が呼ばれる。
   - **縮退**: OpenSEO を止めて質問すると「取得できない」と一度だけ伝え、数値を推測しない。
   - 終了後に `docs/audits/voice/AUD-*.md` ができ、ログに usage が出る。
4. 静的検査: `uv run ruff check && uv run ruff format --check`、`pnpm typecheck`（frontend/next-js）、cfn-lint。

## 非目標

- 電話（SIP）
- アバター
- 有料の OpenSEO ツールと書き込み系のツール
- E-13 の起票
- `/models` 画面でのモデル選択との統合（環境変数で選ぶ）
- LiveKit Cloud の機能（Inference・観測・シミュレーション）
- スターターの `.github/`・`scenarios.yaml` の整理（Cloud 前提で、サブディレクトリなので動かない。今回は触らない）

## リードへの起動プロンプト

```
Agent team を作成して。チーム名 voice-seo-bi。
計画は docs/superpowers/plans/2026-11-21-voice-seo-bi.md、設計は docs/superpowers/specs/2026-11-21-voice-seo-bi-design.md。Wave 0 は済んでいる。ユーザーが G-1（spec の承認）を終えていることを確かめてから、Wave 1 から始める。
teammate は agent-core・seo-bi・multimodal・infra・docs の 5 人で、書き込んでよい範囲は計画の表のとおり。docs 以外は plan approval を必須にする。
Wave 0 はリードだけで行い、G-1 でユーザーの承認を待つ。Global Constraints（テストを書かない・実行しない、ビルド・デプロイ・状態を変える git をしない、.env を読まない、LiveKit の API は docs で確かめる、フロントエンドは LiveKit Components React、SFU の起動と停止は人が行う）を全員に渡す。
G-2・G-3 はユーザーの作業なので、手順を示して止まる。
```
