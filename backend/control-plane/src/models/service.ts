// 実行モデルの選択（2026-11-12。監視アプリの「実行モデル」の画面）。
// 決まり方:
//   Anthropic（エージェント）: エージェントごとの選択 → 全体の既定 → 定義の model（承認済み main の frontmatter）→ SDK の既定
//   OpenAI（アイキャッチ画像）: 画面の選択 → 環境変数 CONTROL_OPENAI_IMAGE_MODEL（無ければ既定。config.ts）
// 画面の選択は承認済み main の定義より優先する（ユーザーの決定。ADR-18 の例外として、誰が・いつ・何から何へを履歴に残す）。
// 選べるのは各社の API の一覧にあるものだけ（Anthropic は SDK のエイリアスも）。一覧を読めないときは変えさせない
// （打ち間違いのモデル名を入れると、夜の定期実行がすべて失敗するため）。
import type { ControlPlaneConfig } from "../config.js";
import type { ModelChoice, ModelSettingScope, ModelSettingTarget, ModelSettingsView } from "../contract.js";
import { listAgentDefinitions } from "../definitions/agent-catalog.js";
import { AGENT_NAME_PATTERN } from "../definitions/agent-def.js";
import { ControlPlaneInputError } from "../errors.js";
import type { ModelSettingsStore } from "../store/models.js";
import { listAnthropicModels, listOpenAiImageModels } from "./available.js";

/** Agent SDK（Claude Code）のエイリアス。SDK の版が決める最新のモデルを指す */
export const ANTHROPIC_ALIASES = ["opus", "sonnet", "haiku"] as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}$/;
const ACTOR_MAX_LENGTH = 200;

export const DEFAULT_SCOPE: ModelSettingScope = "anthropic:default";
export const IMAGE_SCOPE: ModelSettingScope = "openai:image";
export const agentScope = (agent: string): ModelSettingScope => `anthropic:agent:${agent}`;

/** エージェントの次の実行で使うモデルと、その出所 */
export function resolveAgentModel(
  store: ModelSettingsStore,
  agent: string,
  definitionModel: string | null,
): { model: string | null; source: ModelSettingsView["anthropic"]["agents"][number]["source"] } {
  const own = store.get(agentScope(agent));
  if (own) return { model: own, source: "agent" };
  const fallback = store.get(DEFAULT_SCOPE);
  if (fallback) return { model: fallback, source: "default" };
  if (definitionModel) return { model: definitionModel, source: "definition" };
  return { model: null, source: "sdk" };
}

/** アイキャッチ画像のモデル。OpenAI の設定（キー）が無ければ null */
export function resolveImageModel(store: ModelSettingsStore, config: ControlPlaneConfig): string | null {
  if (!config.openai) return null;
  return store.get(IMAGE_SCOPE) ?? config.openai.imageModel;
}

export class ModelService {
  constructor(
    private readonly config: ControlPlaneConfig,
    private readonly store: ModelSettingsStore,
  ) {}

  async getView(): Promise<ModelSettingsView> {
    const [anthropicModels, openaiModels, { definitions }] = await Promise.all([
      listAnthropicModels(this.config.anthropic?.apiKey ?? null),
      listOpenAiImageModels(this.config.openai?.apiKey ?? null),
      listAgentDefinitions(this.config.mainCheckout),
    ]);
    const choices = new Map<ModelSettingScope, ModelChoice>(
      this.store.list().map((row) => [row.scope, { model: row.model, actor: row.actor, updatedAt: row.updatedAt }]),
    );
    const imageOverride = choices.get(IMAGE_SCOPE) ?? null;
    const imageFallback = this.config.openai?.imageModel ?? null;
    return {
      anthropic: {
        configured: this.config.anthropic !== null,
        available: anthropicModels,
        aliases: [...ANTHROPIC_ALIASES],
        default: choices.get(DEFAULT_SCOPE) ?? null,
        agents: definitions.map((definition) => {
          const resolved = resolveAgentModel(this.store, definition.name, definition.model);
          return {
            agent: definition.name,
            definitionModel: definition.model,
            override: choices.get(agentScope(definition.name)) ?? null,
            effective: resolved.model,
            source: resolved.source,
          };
        }),
      },
      openai: {
        configured: this.config.openai !== null,
        available: openaiModels,
        image: {
          override: imageOverride,
          fallback: imageFallback,
          effective: this.config.openai ? (imageOverride?.model ?? imageFallback) : null,
          source: imageOverride ? "screen" : "fallback",
        },
      },
      history: this.store.history(),
    };
  }

  async set(target: ModelSettingTarget, model: string | null, actor: string): Promise<ModelSettingsView> {
    const who = actor.trim();
    if (!who || who.length > ACTOR_MAX_LENGTH) throw new ControlPlaneInputError("操作した人が不正");
    const value = model === null ? null : model.trim();
    if (value !== null && !MODEL_ID.test(value)) throw new ControlPlaneInputError("モデル名の形が不正（英数字・. _ : - の 128 文字まで）");

    let scope: ModelSettingScope;
    if (target.provider === "anthropic") {
      if (target.agent === null) {
        scope = DEFAULT_SCOPE;
      } else {
        if (!AGENT_NAME_PATTERN.test(target.agent)) throw new ControlPlaneInputError("エージェント名が不正");
        const { definitions } = await listAgentDefinitions(this.config.mainCheckout);
        if (!definitions.some((definition) => definition.name === target.agent)) {
          throw new ControlPlaneInputError(`エージェントの定義が無い: ${target.agent}`);
        }
        scope = agentScope(target.agent);
      }
      if (value !== null) {
        if (!this.config.anthropic) throw new ControlPlaneInputError("ANTHROPIC_API_KEY が無いので選べない");
        const isAlias = (ANTHROPIC_ALIASES as readonly string[]).includes(value);
        if (!isAlias) {
          const available = await listAnthropicModels(this.config.anthropic.apiKey);
          if (!available.ok) throw new ControlPlaneInputError(`選べるモデルの一覧を読めないので変えられない（${available.reason}）`);
          if (!available.models.some((m) => m.id === value)) throw new ControlPlaneInputError(`Anthropic の一覧に無いモデル: ${value}`);
        }
      }
    } else {
      scope = IMAGE_SCOPE;
      if (value !== null) {
        if (!this.config.openai) throw new ControlPlaneInputError("OPENAI_API_KEY が無いので選べない");
        const available = await listOpenAiImageModels(this.config.openai.apiKey);
        if (!available.ok) throw new ControlPlaneInputError(`選べるモデルの一覧を読めないので変えられない（${available.reason}）`);
        if (!available.models.some((m) => m.id === value)) throw new ControlPlaneInputError(`OpenAI の画像のモデルの一覧に無い: ${value}`);
      }
    }

    this.store.set(scope, value, who);
    return this.getView();
  }
}
