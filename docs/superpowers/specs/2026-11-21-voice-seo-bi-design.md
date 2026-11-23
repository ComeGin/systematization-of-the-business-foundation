# 音声 SEO BI エージェント（LiveKit セルフホスト × GPT-Live × OpenSEO MCP）

- 作成: 2026-11-21
- 計画: `docs/superpowers/plans/2026-11-21-voice-seo-bi.md`（Agent teams 実行用）
- 関連する正本:
  - ADR-09・10（OpenSEO と MCP）、ADR-21（オンプレとクラウドの分担）、ADR-25（GA4）、ADR-26（Lambda と ECS）
  - AA-03 の 2.4（OpenSEO の許可リスト）、TA-07 の 3.2（監視アプリの「数値」の構想）
  - BA-02 の CAP-01（KPI 管理。`未配線`）
- 新しく作る ID: ADR-33、I-34〜I-38

## 1. 何のためか

夜の観測（analytics-reporter・seo-auditor）は、GSC・GA4 の数値を E-12 に残している。しかし、人がそれを**対話で読み解く入口**が無い。

そこで、音声で話せる SEO の BI の担当者を作る。

- **W1（ブリーフィング）**: 接続した直後に、GSC・GA4 の要点を SEO マーケターの視点で話す。
- **W2（質疑）**: ユーザーの問いに応じて OpenSEO の MCP を呼び、答える。

対話で出た問いと結論は E-12（`source: voice`）に残し、proposal-writer が E-13 の根拠に使えるようにする。こうして改善ループに戻す（再帰的自己改善）。

**失敗とは**:
- 数値をでっち上げる（ツールの結果に無い数字を話す・描く）。
- 費用の出るツールを呼ぶ。
- 話が長い・割り込めない。
- 計測の不具合を見落として誤った解釈を話す。

## 2. 決めたこと

### 2.1 ユーザーの決定（2026-11-21）

| ID | 決定 |
|---|---|
| U1 | SFU（`livekit-server`）は AWS の EC2 に置く。エージェントと OpenSEO はオンプレに置き、エージェントは wss で外向きにつなぐ |
| U2 | 画面は監視アプリ（`frontend/next-js`）に `/voice` を足す |
| U3 | ノイズ対策はブラウザの WebRTC を基本にし、エージェント側で無料でできる音声強化（WebRTC の APM）を組み込む。話者分離は有償（ai-coustics・Krisp の自前のライセンス）なので、切り替えの口だけ用意する |
| U4 | テストは書かない・実行しない。静的検査（ruff・typecheck・cfn-lint）だけを行う |
| U5 | 会話のモデルは OpenAI GPT-Live |
| U6 | SFU は Auto Scaling グループに入れ、起動と停止は人が手で行う。停止はインスタンスを削除しない（warm pool の Stopped） |
| U7 | フロントエンドは LiveKit Components React で作る |
| U8 | 映像は、聞かれたときだけ最新の 1 フレームを OpenAI Responses のビジョンモデルに渡す（gpt-realtime で常に見る形は採らない） |

### 2.2 目標・非目標

- **目標**: W1・W2、画面のカード（数値は必ずツールの結果から作る）、画面共有の読み取り、割り込み、音声強化、E-12 への記録、SFU の手動での起動と停止。
- **非目標**:
  - 電話（SIP）、アバター
  - 有料・書き込み系の OpenSEO ツール
  - E-13 の起票
  - `/models` 画面との統合
  - LiveKit Cloud の機能（Inference・観測・シミュレーション）
  - スターターの `.github/`・`scenarios.yaml` の整理

## 3. 制約（調べて分かった事実）

| # | 事実 | 出典 |
|---|---|---|
| C1 | GPT-Live は音声専用。映像・画像の入力は、裏のモデルにも渡せない | livekit-docs `/agents/models/realtime/gpt-live` |
| C2 | GPT-Live では、ハンドオフすると新しいセッションになる。声・指示はセッションの途中で変えられない。ツールは同じ接続のまま差し替えられる | 同上 |
| C3 | 指示が 2 つに分かれる。声のモデルは `Agent.instructions`、裏のモデル（Responses）は `responses_options.instructions` | 同上 |
| C4 | セルフホストでは LiveKit Inference が無い。そのため Krisp・ai-coustics（Cloud 経由）、適応型の割り込み判定、turn detector も使えない。OpenAI のプラグイン（`OPENAI_API_KEY`）を使う | `/transport/self-hosting` |
| C5 | 割り込みでは、フレームワークが**再生を止めるだけ**で、モデルは自分で話し終えるまで話し続ける。VAD は明示的に渡す必要がある | `/agents/models/realtime`（Full-duplex の表） |
| C6 | OpenSEO は `local_noauth`。`127.0.0.1:3001` だけで受け、Host が localhost 系でないと 403 を返す | `middleware/open-seo-main/src/server/mcp/transport.ts` |
| C7 | GSC・GA4 のツールはすべて無料（DataForSEO を使わない） | `src/server/mcp/tools/*.ts`、AA-03 の 2.4 |
| C8 | WebRTC のメディアは UDP。ngrok は UDP を通せない | `/transport/self-hosting/ports-firewall` |

## 4. Wave 0 で確かめたこと（2026-11-21）

| # | 問い | 結果 | 根拠 | 設計への反映 |
|---|---|---|---|---|
| (a) | MCP のツールは GPT-Live の裏のモデルに渡るか | **渡る**。toolset は平らに展開され、MCP のツール（`RawFunctionTool`）は raw schema のまま、委譲先の関数ツールになる | `livekit-agents/livekit/agents/llm/_realtime/gpt_live.py` の `_build_delegation_tools` | D2 のまま |
| (b) | テキストのユーザー入力を受けるか | **受ける**。既定のテキスト入力の処理は `generate_reply(user_input=...)` を呼び、GPT-Live では「Reply to the caller now…」の commentary として渡る | 同ファイルの `_generate_reply`・`_ASK_TYPED`、`voice/room_io/types.py` の `_default_text_input_cb` | D6: チャット欄を出す（`lk.chat`。既定の TextInputOptions のまま） |
| (c) | VAD による割り込みの設定は効くか | 効くのは**再生を止めること**だけ。モデルの発話そのものは止められず、モデルは聞かせていない部分も覚えている | `/agents/models/realtime` の Full-duplex の表、gpt-live の「Turn detection and interruption」 | D7: `min_interruption_duration` の調整だけに頼る。`resume_false_interruption` は効くかを G-2 でログを見て確かめ、効かなければ外す。人格の指示に「割り込まれたら、言い直さず短く確認する」を入れる |
| (d) | 自作の FrameProcessor を `noise_cancellation` に渡せるか | **渡せる**。型は `rtc.NoiseCancellationOptions \| NoiseCancellationSelector \| rtc.FrameProcessor[rtc.AudioFrame] \| None`。入力のフレームは既定で 50 ms（`frame_size_ms`）。APM は 10 ms 単位なので、5 つに分けて処理し、つなぎ直す。`AudioInputOptions.auto_gain_control` も元からある | `voice/room_io/types.py`、`livekit-rtc/livekit/rtc/apm.py`・`frame_processor.py` | D-U3: APM は `noise_suppression`・`high_pass_filter` だけにし、AGC はフレームワークの `auto_gain_control=True` を使う |
| (e) | 開発の SFU の起動 | `livekit-server --dev`（キーは `devkey`・`secret`）。既定で `127.0.0.1:7880` だけで受ける | `/transport/self-hosting/local` | D9: compose（`livekit/livekit-server` の公式イメージ、`network_mode: host`、`--dev --bind 127.0.0.1`）。ポートは 7880・7881/tcp・7882/udp |
| (f) | E-12 の置き場 | `docs/audits/<source>/AUD-YYYY-MMDD-<source>-NNNN.md`。ID は `^AUD-\d{4}-\d{4}-[a-z_]+-\d{4}$`。監視アプリは作業ツリー → 承認済み main の順に frontmatter を読む。書式は `docs/audits/_template.md` | `backend/control-plane/src/definitions/audits.ts`、`docs/audits/README.md` | D12: `source: voice`、`created_by: agent/voice-seo-bi`、`fetch.correlation_id` はセッションの ID（ULID）。書き先は `VOICE_AUDIT_DIR`（監視アプリの作業ツリーの `docs/audits/voice/`） |
| (g) | トークンを発行する API の形と、Components React のフック | `POST` の JSON（`room_name`・`participant_identity`・`participant_name`・`room_config` ほか）に、`201` で `{ server_url, participant_token }` を返す。クライアントに決めさせない項目は 4xx で断る。フックは `useSession(TokenSource.endpoint(url), { agentName })`・`SessionProvider`・`useAgent`・`BarVisualizer`・`ControlBar`・`RoomAudioRenderer`・`useTracks`・`VideoTrack` | `/frontends/build/authentication/endpoint`、`/frontends/start/react-quickstart` | 5.4 のとおり。文字起こし・text stream のフック名は、入れた版の型定義で確かめる |
| (h) | warm pool から起動したとき user data は動くか | **動かない**。user data は、warm pool に入る最初の起動で 1 回だけ動く。最初の起動と、warm pool からの起動の両方で、起動時のライフサイクルフック（lifecycle hook）が待機（`Warmed:Pending:Wait` / `Pending:Wait`）に入る | AWS「Use lifecycle hooks with a warm pool」 | D8c: `EC2_INSTANCE_LAUNCHING` のフックを置く（タイムアウトは 600 秒、既定の動作は `ABANDON`）。起動のたびに systemd の oneshot が、EIP の付け替え → SSM から設定を作る → `complete-lifecycle-action CONTINUE` を行う。user data は導入だけを行い、最後に同じ oneshot を起動する |

## 5. 全体の形

### 5.1 経路（新しい連携点）

| ID | 元 → 先 | 方式 | 認証 |
|---|---|---|---|
| I-34 | ブラウザ → 監視アプリ `/api/livekit/token` | HTTPS（同じオリジン） | 監視アプリのセッション（Google＋許可リスト）。`guardApiRequest` |
| I-35 | ブラウザ ⇄ SFU | wss（`rtc.comegin.com:443`）＋ WebRTC（UDP 50000-60000・TCP 7881・TURN） | LiveKit のトークン（TTL 10 分） |
| I-36 | オンプレのエージェント ⇄ SFU | wss（外向き）＋ WebRTC | API キーとシークレット |
| I-37 | エージェント → OpenSEO | Streamable HTTP（`127.0.0.1:3001/mcp`） | なし（ループバックだけ。C6） |
| I-38 | エージェント → OpenAI | wss（GPT-Live）・HTTPS（Responses のビジョン） | `OPENAI_API_KEY` |

### 5.2 エージェントの流れ

1. dispatch（`agent_name="comegin-seo-bi"`）でジョブを受ける。
2. `openseo/client.py` で `list_projects` を呼び、`OPENSEO_PROJECT_DOMAIN` の projectId を決める。0 件・複数件なら縮退する（「プロジェクトが決められない」と話し、W1 を出さない）。
3. 指示を組み立てる。
   - 声: `voice/persona.py`
   - 裏: `bi/analyst.py` に projectId と今日の日付（JST）を埋め込む
4. `AgentSession` を始める。設定は次のとおり。
   - `GPTLiveModel(voice, responses_options={model, instructions, reasoning:{effort:"low"}, text:{verbosity:"low"}, parallel_tool_calls:true})`
   - `vad=silero`、ツールは MCPToolset と関数ツール
   - RoomOptions: 音声の入力、テキストの入力、文字起こし、APM
5. W1: `bi/briefing.py` が並列で呼ぶ（measurement_health・organic_overview・GSC の query と page の前期比・search_opportunities）。指標を計算し、カードを送り、事実を `append_thinking` で渡す。そのうえで `generate_reply(instructions="ブリーフィングを 3 点以内で")` で話し始める。
6. W2: 裏のモデルが MCP を呼ぶ。resolver（`openseo/toolset.py`）は次の 4 つを行う。
   - 結果を台帳に記録する。
   - カードを送る。
   - 圧縮した事実をモデルに返す。
   - 呼び出しが 40 回を超えたら、エラーを返す。
7. 終了: 上限（30 分・無発話）か切断で終わる。`session.usage` をログに出し、E-12 を書く。

### 5.3 SEO マーケターの手順（`bi/analyst.py`）

計画書の「SEO マーケターの視点」を正本とする。要点は次の 4 つ。
- 計測の健全性を先に見る。
- 必ず前の期間と比べる。
- 伸びしろの順に並べる（あと一歩の語・CTR・CVR・カニバリゼーション・インデックス）。
- 話すのは 3 点までで、各点を「事実 → 解釈 → 次の一手」の順にする。分からないことは分からないと言う。

### 5.4 画面（`frontend/next-js`、U7）

- トークンの API（`app/api/livekit/token/route.ts`）:
  - `guardApiRequest` を通す。GET 以外は同じオリジンだけを受ける。
  - identity はセッションのメール。本文の `participant_identity`・`room_name` が来たら 400 にする。
  - ルーム名は `voice-<uuid>`。
  - `room_config.agents[].agent_name` が `LIVEKIT_AGENT_NAME` と違えば 400 にする。
  - 付与する権限は `roomJoin`・`canPublish`・`canSubscribe`・`canPublishData` で、TTL は 10 分。
  - 接続中のトークンは失効させない（許容する。2026-11-21 のレビュー）。許可リストから外した人やログアウトした人でも、つながっている音声セッションは終わるまで続く（SFU がトークンを自動で更新するため）。セルフホストの SFU には失効の仕組みが無く、セッションも最長 30 分なので、これを受け入れる。急いで切りたいときは、`livekit-sfu.mjs stop` で SFU ごと止める。
  - SFU に届かないとき（停止中）は、画面に「SFU が停止中（`node cloud/livekit-sfu.mjs start`）」と出す。トークンを発行しても、接続の段で失敗するためである。
- 部品:
  - `useSession(TokenSource.endpoint("/api/livekit/token"), { agentName })` と `SessionProvider`
  - `useAgent` と `BarVisualizer`
  - `ControlBar`（マイク・カメラ・画面共有）、`RoomAudioRenderer`
  - 文字起こしとチャット欄
  - `BiCardList`（topic `comegin.bi.card`。グラフは Cloudscape）
  - `@livekit/components-styles` は `/voice` の中だけに効かせる。
- マイク: `echoCancellation: true`、`noiseSuppression: false`、`autoGainControl: false`（U3。抑制はエージェント側で行う）。

### 5.5 カードの型（エージェント ⇔ 画面の契約）

```json
{ "v": 1, "id": "crd_…", "kind": "kpi|table|line|bar", "title": "…",
  "period": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "compare": { "start": "…", "end": "…" } },
  "source_tool": "get_search_console_performance", "result_id": "res_…",
  "data": { "columns": [...], "rows": [[...]] } }
```

- 1 つのカードは 15 KB まで。超えるときは、行を上位 20 行に切り、`truncated: true` を付ける。
- `kind` が知らない値なら、画面は表として描く。

### 5.6 SFU（AWS）

計画書の D8a〜D8f のとおり。(h) を受けて、次の 2 つを加える。
- `EC2_INSTANCE_LAUNCHING` のライフサイクルフックを置く。
- インスタンスロールに `autoscaling:CompleteLifecycleAction` を許す（対象はこの ASG だけ）。

### 5.7 オンプレ

- `onprem/systemd/comegin-livekit-agent.service` を置く（`Type=simple`、`uv run src/agent.py start`、`Restart=on-failure`）。ヘルスのポートは 8081（127.0.0.1）。
- SFU が止まっている間、エージェントは接続を再試行し続ける。ログは出るが、異常ではない。TA-05 にそう書く。

## 6. 文書の更新（docs が担当）

- **AA-05**: ADR-33。リスク受容は次の 3 つ。
  - 音声と画面のフレームが OpenAI（米国）に渡る。
  - OpenSEO に、Claude のエージェント定義の外から接続する元が増える（ADR-10 の決定 1・2 の改訂。許可リストはコードの `openseo/allowlist.py` が正本）。
  - SFU の EC2 を ADR-26 の例外とする。
- **AA-01・AA-02**: I-34〜I-38
- **AA-03 の 2.4**: 許可リスト
- **BA-02**: CAP-01 への追記
- **TA-01**: ポートと配置。7880・7881・7882・8081、EC2 の 80・443・7881・3478・50000-60000
- **TA-05**: 監視（SFU が停止中の扱い）
- **TA-06**: SFU の EC2
- **TA-07**: エージェントの常駐
- **`.claude/CLAUDE.md`**: ポート表、自作コードの表（`backend/livekit-agent`・`backend/livekit-system`）
- **`docs/README.md`**: 索引の更新漏れ（ADR は 28 まで・I は 30 までのまま）を直す。

## 7. 作る人に任せること

- フレームの切り分けの実装（50 ms ↔ 10 ms）。
- 圧縮の形（事実の JSON のキーの名前）。
- Cloudscape のどのグラフを使うか。
- Caddy の SNI の振り分けの書き方。
- user data の導入の手順。
- `livekit-sfu.mjs` の待ち方。
- いずれも LiveKit・AWS のドキュメントで確かめてから書く。

## 8. 検証

テストのコードは作らない（U4）。計画書の「検証（G-2）」のとおり、人が開発の環境で手で確かめる。静的検査は ruff・`pnpm typecheck`・cfn-lint で行う。

## 9. Python のモジュール間の契約（2026-11-21。Wave 1 の前に固定）

- パッケージは `backend/livekit-agent/src/comegin_voice/`。入口は `src/agent.py`（`uv run src/agent.py dev|start`。`src/` が sys.path に入るので `import comegin_voice` が通る）。
- 各モジュールには `__init__.py` を置く。
- 型は pydantic v2（livekit-agents が依存に持つ）と dataclass を使う。
- 名前を変えるときは、リードに知らせてから変える。

```python
# config/settings.py（agent-core）
class Settings(BaseModel):  # frozen
    livekit_url: str; livekit_api_key: SecretStr; livekit_api_secret: SecretStr
    openai_api_key: SecretStr
    openseo_mcp_url: str = "http://127.0.0.1:3001/mcp"
    openseo_project_domain: str = "comegin.com"
    agent_name: str = "comegin-seo-bi"
    gpt_live_voice: str = "marin"; backend_model: str = "gpt-5.6-luna"; vision_model: str = "gpt-5.6-luna"
    session_max_minutes: int = 30; max_tool_calls: int = 40
    voice_audit_dir: Path | None = None          # None なら E-12 を書かない（警告を 1 回出す）
    audio_enhancement: Literal["apm", "off", "ai_coustics", "krisp"] = "apm"
def load_settings() -> Settings: ...            # 失敗時は「変数名と理由だけ」を stderr に出して SystemExit(1)

# visual_output/cards.py（seo-bi）
class Card(BaseModel): v: Literal[1] = 1; id: str; kind: Literal["kpi","table","line","bar"]; title: str
    period: Period; source_tool: str; result_id: str; data: CardData; truncated: bool = False
class CardSink(Protocol):
    async def send(self, card: Card) -> None: ...
class RoomCardSink:                              # text stream（topic "comegin.bi.card"）。送れなくても例外を投げずにログだけ出す
    def __init__(self, room: rtc.Room) -> None: ...
CARD_TOPIC = "comegin.bi.card"

# bi/state.py（seo-bi）
@dataclass
class ToolResultRecord: result_id: str; tool: str; args: dict; ok: bool; summary: dict; at: datetime
@dataclass
class BiSessionState:
    session_id: str                              # ULID。E-12 の fetch.correlation_id に使う
    project_id: str | None
    started_at: datetime
    results: list[ToolResultRecord]; questions: list[str]; tool_calls: int = 0
    def next_result_id(self) -> str: ...

# openseo/client.py（seo-bi）。W1 とプロジェクトの解決に使う。MCP の Python SDK（livekit-agents[mcp] の依存）の streamable HTTP クライアント
class OpenSeoError(Exception): ...               # 失敗の種類を outcome（unreachable/timeout/invalid_response…）で持つ
class OpenSeoClient:
    def __init__(self, url: str, *, timeout_s: float = 20.0) -> None: ...
    async def call(self, tool: str, args: dict) -> dict: ...   # 許可リストに無いツールは呼ばずに例外にする。structuredContent を返す
    async def resolve_project_id(self, domain: str) -> str: ... # 0 件・複数件は OpenSeoError
    async def aclose(self) -> None: ...

# openseo/allowlist.py（seo-bi）
ALLOWED_TOOLS: frozenset[str]                    # spec の D3 の 11 本＋ list_projects（client の内部専用。モデルには出さない）
MODEL_TOOLS: tuple[str, ...]                     # モデルに見せる 11 本

# openseo/toolset.py（seo-bi）。W2 用
def build_openseo_toolset(settings: Settings, state: BiSessionState, sink: CardSink) -> mcp.MCPToolset: ...

# bi/briefing.py（seo-bi）
@dataclass
class BriefingResult: facts: str; cards: list[Card]; outcome: Literal["ok","partial","failed"]
async def run_briefing(client: OpenSeoClient, state: BiSessionState, sink: CardSink, *, today: date) -> BriefingResult: ...
# facts は append_thinking に渡す日本語の事実（500 トークン以内）。数値は台帳の result_id を付ける

# bi/analyst.py（seo-bi）
def build_backend_instructions(*, project_id: str, today: date) -> str: ...

# voice/persona.py（agent-core）
VOICE_INSTRUCTIONS: str
# voice/audio_processing.py（agent-core）
def build_noise_cancellation(settings: Settings) -> rtc.FrameProcessor[rtc.AudioFrame] | None: ...
# voice/session.py（agent-core）
def build_session(settings: Settings) -> AgentSession: ...
def build_room_options(settings: Settings) -> room_io.RoomOptions: ...

# vision/frames.py・vision/tools.py（multimodal）
class LatestFrameBuffer:                         # 画面共有を優先し、無ければカメラ。保存しない
    def __init__(self, room: rtc.Room) -> None: ...
    def latest(self) -> rtc.VideoFrame | None: ...
    async def aclose(self) -> None: ...
def build_vision_tool(buffer: LatestFrameBuffer, settings: Settings) -> FunctionTool: ...  # 名前は look_at_shared_screen

# observability/session_log.py・audit.py（agent-core）
def log_usage(session: AgentSession, state: BiSessionState) -> None: ...
def write_voice_audit(state: BiSessionState, settings: Settings) -> Path | None: ...  # docs/audits/voice/AUD-…（_template.md の形。source: voice）
```

- 組み立て（`agent.py`）は agent-core が担当する。処理の順は次のとおり。
  1. `load_settings`
  2. `rtc_session(agent_name)`
  3. `ctx.connect`
  4. `BiSessionState`・`OpenSeoClient`・`RoomCardSink`・`LatestFrameBuffer` を作る
  5. `resolve_project_id`
  6. `SeoBiAgent(instructions=VOICE_INSTRUCTIONS, llm=GPTLiveModel(responses_options={"instructions": build_backend_instructions(...)}), tools=[build_openseo_toolset(...), build_vision_tool(...)])`
  7. `session.start`
  8. `run_briefing`（`on_enter` で行う）→ `duplex_session.append_thinking(facts)` → `generate_reply(...)`
  9. 終了時のコールバックで `log_usage`・`write_voice_audit`・`aclose`
