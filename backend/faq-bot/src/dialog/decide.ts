import type { QuestionEvent, SelectionEvent } from "../chatwoot/events.js";
import type { ChoiceItem, Reply } from "../chatwoot/types.js";
import { CHOICE, LABELS, MAX_CANDIDATES, MESSAGES } from "../constants.js";
import type { FaqItem } from "../faq/schema.js";
import type { FaqSnapshot } from "../faq/store.js";
import { normalize, type Ranked, rank } from "../matcher/index.js";

export interface Thresholds {
  readonly high: number;
  readonly low: number;
  readonly margin: number;
}

export type Decision = "answer" | "candidates" | "unmatched" | "handoff" | "resolved";

/** 1 回の応答で行うこと（仕様 7.2）。副作用は execute が行う */
export interface Action {
  readonly decision: Decision;
  readonly reply: Reply;
  readonly addLabels: readonly string[];
  readonly status: "open" | "resolved" | null;
  /** 答えた FAQ（answer）か、候補に出した FAQ（candidates）の id */
  readonly faqIds: readonly string[];
  /** 質問の 1 位のスコア（選択のときは null） */
  readonly topScore: number | null;
}

const choice = (title: string, value: string): ChoiceItem => ({ title, value });

/** 候補の見出し。同じ質問が複数のページにあるため、context を括弧で付ける（仕様 7.2） */
export function candidateTitle(item: FaqItem): string {
  return item.context ? `${item.question}（${item.context}）` : item.question;
}

/** 答えが実質同じか（正規化した一方が他方を含む）。正規化して空の答えは、何とも同じとみなさない */
export function sameAnswer(a: FaqItem, b: FaqItem): boolean {
  const x = normalize(a.answer);
  const y = normalize(b.answer);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

function answer(item: FaqItem, topScore: number | null): Action {
  return {
    decision: "answer",
    reply: {
      kind: "select",
      content: `${item.answer}\n\n${MESSAGES.answerLinkPrefix}${item.url}`,
      items: [choice(MESSAGES.choiceResolved, CHOICE.resolved), choice(MESSAGES.choiceHandoff, CHOICE.handoff)],
    },
    addLabels: [LABELS.answered],
    status: null,
    faqIds: [item.id],
    topScore,
  };
}

function handOff(decision: "unmatched" | "handoff", topScore: number | null): Action {
  return {
    decision,
    reply: { kind: "text", content: MESSAGES.handoff },
    addLabels: [decision === "unmatched" ? LABELS.unmatched : LABELS.handoff],
    status: "open",
    faqIds: [],
    topScore,
  };
}

/** 答えの同じ候補を 1 つにまとめる（先に出たほうを残す） */
function distinctAnswers(ranked: readonly Ranked<FaqItem>[]): Ranked<FaqItem>[] {
  const out: Ranked<FaqItem>[] = [];
  for (const r of ranked) if (!out.some((kept) => sameAnswer(kept.item, r.item))) out.push(r);
  return out;
}

function decideQuestion(text: string, snapshot: FaqSnapshot, t: Thresholds): Action {
  const ranked = rank(text, snapshot.index);
  const top = ranked[0];
  if (!top || top.score < t.low) return handOff("unmatched", top?.score ?? 0);
  // 2 位は、1 位と答えが実質同じ項目を飛ばして数える（仕様 7.2）
  const runnerUp = ranked.slice(1).find((r) => !sameAnswer(r.item, top.item));
  if (top.score >= t.high && top.score - (runnerUp?.score ?? 0) >= t.margin) return answer(top.item, top.score);
  const picks = distinctAnswers(ranked.filter((r) => r.score > 0)).slice(0, MAX_CANDIDATES);
  return {
    decision: "candidates",
    reply: {
      kind: "select",
      content: MESSAGES.candidatesPrompt,
      items: [...picks.map((r) => choice(candidateTitle(r.item), r.item.id)), choice(MESSAGES.choiceNone, CHOICE.none)],
    },
    addLabels: [],
    status: null,
    faqIds: picks.map((r) => r.item.id),
    topScore: top.score,
  };
}

function decideSelection(value: string, snapshot: FaqSnapshot): Action {
  if (value === CHOICE.resolved) {
    return { decision: "resolved", reply: { kind: "text", content: MESSAGES.resolved }, addLabels: [], status: "resolved", faqIds: [], topScore: null };
  }
  if (value === CHOICE.handoff) return handOff("handoff", null);
  const item = snapshot.byId.get(value);
  // ［どれにも当てはまらない］と、faq.json から消えた FAQ の id
  return item ? answer(item, null) : handOff("unmatched", null);
}

export function decide(event: QuestionEvent | SelectionEvent, snapshot: FaqSnapshot, thresholds: Thresholds): Action {
  return event.kind === "question" ? decideQuestion(event.text, snapshot, thresholds) : decideSelection(event.value, snapshot);
}
