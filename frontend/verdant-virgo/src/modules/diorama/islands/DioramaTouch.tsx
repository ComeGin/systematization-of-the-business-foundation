// トップの模型の「押せる部品」とパネル（spec §6.2・§6.3・§6.4）。DioramaIsland の中だけで使う。
// - 押せる部品ごとに、canvas の上へ本物の <button> を重ねる（canvas は aria-hidden）。位置は、立体のときは毎フレーム scene.projectAnchors()、
//   ポスターのとき（reduced-motion・WebGL なし・一時停止で開いた・遅い端末）は書き出しの anchors.json（ポスターに対する %）から求める。
// - hover・focus-visible で部品が持ち上がる（scene.setHover。根に data-diorama-hover）。部品の本体（canvas）にカーソルを乗せても同じ（scene.pick）。
// - 押すとカメラが部品へ寄り（scene.focusPart）、パネルが 1 つだけ開く。Esc・閉じるボタン・外側を押すと閉じ、押したボタンへフォーカスを戻す。
// - Mobile（767px 以下）は模型の枠が小さく点どうしが重なるので、点を重ねず、模型の上端に部品の名前のボタンを横に並べる（横にスクロール）。
// perf: 位置は React の再描画をせず、ref で transform を書く。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { CaseStudy } from "@/modules/site-content/cases";
import type { DioramaPartCopy } from "@/modules/site-content/diorama";
import { layoutMarkers, type MarkerPoint } from "../lib/markers";
import { PARTS } from "../lib/parts";
import type { DioramaScene } from "../lib/scene";
import type { PartId } from "../lib/types";
import DioramaPanel, {
  type DioramaCasesCopy,
} from "../components/DioramaPanel";

export interface DioramaTouchCopy {
  parts: Record<PartId, DioramaPartCopy>;
  cases: { copy: DioramaCasesCopy; items: readonly CaseStudy[] };
  close: string;
  hint: string;
  partsLabel: string;
  newTabNotice: string;
}

interface Props {
  copy: DioramaTouchCopy;
  /** ポスターの上での部品の位置（ポスター〈16:9〉に対する %） */
  stillAnchors: Partial<Record<PartId, { x: number; y: number }>>;
  boxRef: RefObject<HTMLDivElement | null>;
  getScene(): DioramaScene | null;
  /** 立体を描いた後に毎回呼ぶ関数を登録する（戻り値で外す） */
  subscribeFrame(fn: () => void): () => void;
  /** 立体に替わった（false の間はポスターの位置に置く） */
  live: boolean;
  /** ポスターの置き方（object-position。center か end〈右端〉） */
  align: "center" | "end";
}

/** ポスター（object-fit: contain）の、box の中での位置と大きさ */
const POSTER_ASPECT = 16 / 9;
function posterRect(w: number, h: number, align: "center" | "end") {
  if (w / h > POSTER_ASPECT) {
    const pw = h * POSTER_ASPECT;
    return { x: align === "end" ? w - pw : (w - pw) / 2, y: 0, w: pw, h };
  }
  const ph = w / POSTER_ASPECT;
  return { x: 0, y: (h - ph) / 2, w, h: ph };
}

const ORDER = (Object.keys(PARTS) as PartId[]).filter(
  (id) => PARTS[id].touchable,
);
const PANEL_W = 320;
/** 点（32px）の中心どうしの最小の間隔と、枠の端からの余白（px） */
const MARKER_GAP = 34;
const MARKER_MARGIN = 20;
const MOBILE = "(max-width: 767px)";

export default function DioramaTouch({
  copy,
  stillAnchors,
  boxRef,
  getScene,
  subscribeFrame,
  live,
  align,
}: Props) {
  const buttons = useRef(new Map<PartId, HTMLButtonElement>());
  const [hydrated, setHydrated] = useState(false);
  const [hover, setHover] = useState<PartId | null>(null);
  const [open, setOpen] = useState<{
    id: PartId;
    position: { left: number; top: number } | null;
  } | null>(null);
  const returnTo = useRef<PartId | null>(null);
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    setHydrated(true);
    const query = window.matchMedia(MOBILE);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const place = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    if (window.matchMedia(MOBILE).matches) {
      for (const el of buttons.current.values()) {
        el.hidden = false;
        el.style.transform = "";
      }
      return;
    }
    const w = box.clientWidth;
    const h = box.clientHeight;
    const scene = live ? getScene() : null;
    const projected = scene?.projectAnchors();
    const poster = posterRect(w, h, align);
    const points: MarkerPoint[] = [];
    for (const id of buttons.current.keys()) {
      const p = projected?.get(id);
      if (p) points.push({ id, x: p.x, y: p.y });
      else {
        const a = stillAnchors[id];
        // 書き出しで枠の外だった部品は、枠の中央に置いてから端へ寄せる（隠さない）
        points.push(a ? { id, x: poster.x + (a.x / 100) * poster.w, y: poster.y + (a.y / 100) * poster.h } : { id, x: Number.NaN, y: Number.NaN });
      }
    }
    // a11y: 点どうしを離し（2.5.8）、枠の外の部品も隠さず端に寄せる（2.1.1）
    for (const m of layoutMarkers(points, { width: w, height: h, margin: MARKER_MARGIN, minGap: MARKER_GAP })) {
      const el = buttons.current.get(m.id as PartId);
      if (!el) continue;
      el.hidden = false;
      el.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px)`;
    }
  }, [boxRef, getScene, live, stillAnchors, align]);

  // 毎フレーム（立体）・大きさの変化・立体とポスターの入れ替え
  useEffect(() => {
    if (!hydrated) return undefined;
    place();
    const box = boxRef.current;
    // 立体のときは、島が scene の大きさを合わせた後で置き直す（subscribeFrame。最終レビュー I-5）。ポスターのときだけ自前で大きさを見る
    const observer = box && !live ? new ResizeObserver(() => place()) : null;
    if (box) observer?.observe(box);
    const off = live ? subscribeFrame(place) : () => {};
    return () => {
      observer?.disconnect();
      off();
    };
  }, [hydrated, live, mobile, place, boxRef, subscribeFrame]);

  // 持ち上げ（立体）と、根の data-diorama-hover（CSS・e2e が読む）
  useEffect(() => {
    getScene()?.setHover(hover ?? open?.id ?? null);
    const host = boxRef.current?.closest<HTMLElement>(
      '[data-motion="diorama"]',
    );
    if (!host) return;
    if (hover) host.setAttribute("data-diorama-hover", hover);
    else host.removeAttribute("data-diorama-hover");
  }, [hover, open, getScene, boxRef]);

  /**
   * パネルを閉じる。フォーカスを押したボタンへ戻すのは、閉じる直前のフォーカスがパネルの中か body にあったときだけ
   * （外側を押して閉じたときは、押した先のフォーカスを尊重する）。戻すときも画面を動かさない（preventScroll。最終レビュー I-1）
   */
  const close = useCallback(
    (restoreFocus: boolean) => {
      const active = document.activeElement;
      const fromPanel = !active || active === document.body || !!active.closest("[data-diorama-panel]");
      setOpen(null);
      getScene()?.focusPart(null);
      const id = returnTo.current;
      if (id && restoreFocus && fromPanel) buttons.current.get(id)?.focus({ preventScroll: true });
    },
    [getScene],
  );

  const openPart = useCallback(
    (id: PartId) => {
      const box = boxRef.current;
      const el = buttons.current.get(id);
      returnTo.current = id;
      getScene()?.focusPart(id);
      let position: { left: number; top: number } | null = null;
      if (box && el && !window.matchMedia(MOBILE).matches) {
        const b = box.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2 - b.left;
        const y = r.top + r.height / 2 - b.top;
        const left = x > b.width * 0.55 ? x - 28 - PANEL_W : x + 28;
        position = {
          left: Math.max(8, Math.min(left, b.width - PANEL_W - 8)),
          top: Math.max(8, Math.min(y - 48, b.height - 280)),
        };
      }
      setOpen({ id, position });
    },
    [boxRef, getScene],
  );

  // Esc・外側を押すと閉じる
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-diorama-panel], [data-diorama-part]")) return;
      close(false);
    };
    // ヒーローが画面から外れたら閉じる（フォーカスは戻さない。読み進めた先から引き戻さない）
    const box = boxRef.current;
    const offscreen =
      box && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) close(false);
          })
        : null;
    if (box) offscreen?.observe(box);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      offscreen?.disconnect();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, close, boxRef]);

  // 部品の本体（canvas）にカーソルを乗せる・押す。canvas は文字の後ろにあるので、ヒーローの区画で受けて pick する
  useEffect(() => {
    const box = boxRef.current;
    const frame = box?.closest("section") ?? null;
    if (!box || !frame || !live) return undefined;
    let picked: PartId | null = null;
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const target = event.target as Element | null;
      if (target?.closest("a, button, input, [data-diorama-panel]")) return;
      const r = box.getBoundingClientRect();
      const id =
        getScene()?.pick(event.clientX - r.left, event.clientY - r.top) ?? null;
      if (id === picked) return;
      picked = id;
      setHover(id);
      (frame as HTMLElement).style.cursor = id ? "pointer" : "";
    };
    const onLeave = () => {
      picked = null;
      setHover(null);
      (frame as HTMLElement).style.cursor = "";
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!picked || target?.closest("a, button, input, [data-diorama-panel]"))
        return;
      openPart(picked);
    };
    frame.addEventListener("pointermove", onMove as EventListener);
    frame.addEventListener("pointerleave", onLeave);
    frame.addEventListener("click", onClick as EventListener);
    return () => {
      frame.removeEventListener("pointermove", onMove as EventListener);
      frame.removeEventListener("pointerleave", onLeave);
      frame.removeEventListener("click", onClick as EventListener);
    };
  }, [boxRef, getScene, live, openPart]);

  if (!hydrated) return null;

  return (
    <>
      <div
        role="group"
        aria-label={copy.partsLabel}
        className={mobile ? "diorama-parts diorama-parts--list" : "diorama-parts absolute inset-0"}
      >
        {ORDER.map((id) => (
          <button
            key={id}
            type="button"
            data-diorama-part={id}
            ref={(el) => {
              if (el) buttons.current.set(id, el);
              else buttons.current.delete(id);
            }}
            aria-expanded={open?.id === id}
            onPointerEnter={() => setHover(id)}
            onPointerLeave={() => setHover((h) => (h === id ? null : h))}
            onFocus={() => setHover(id)}
            onBlur={() => setHover((h) => (h === id ? null : h))}
            onClick={() => (open?.id === id ? close(true) : openPart(id))}
            className="diorama-part pointer-events-auto"
          >
            <span aria-hidden="true" className="diorama-part__dot" />
            <span className="diorama-part__label">{copy.parts[id].name}</span>
          </button>
        ))}
      </div>
      <p aria-hidden="true" className="diorama-hint type-small">
        {copy.hint}
      </p>
      {open && (
        <DioramaPanel
          id={open.id}
          copy={copy.parts[open.id]}
          closeLabel={copy.close}
          newTabNotice={copy.newTabNotice}
          cases={open.id === "desk" ? copy.cases : undefined}
          position={open.position}
          onClose={() => close(true)}
        />
      )}
    </>
  );
}
