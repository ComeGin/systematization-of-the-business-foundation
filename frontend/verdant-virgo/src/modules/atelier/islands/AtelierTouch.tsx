// トップのアトリエの「押せる置き物」と Tips（spec §6.3・§8）。AtelierIsland の中だけで使う（立体が動いている間だけ。動かないときは AtelierList）。
// - 移り先を持つ置き物 8 つと、移り先を持つ額（jis・掲載許可の出た他社）に、canvas の上へ本物の <button> を重ねる（canvas は aria-hidden）。
//   位置は毎フレーム scene.projectAnchors()。点どうしを 34px 以上離す（layoutMarkers。2.5.8）。
//   画面の外・カメラの後ろの置き物のボタンは隠す（一人称では、後ろの置き物を画面の中央へ寄せると、どこを指すのか分からない）。
//   キーボードでも「前へ進む」「入口に戻る」が置き物ごとに止まるので、どの置き物にも届く（2.1.1）。
//   Desktop では左下の文字の板の下に潜らないよう、板の右へよける。
// - 開き方: カーソルを乗せる（ボタン・canvas の置き物）と Tips が出る。押す（Enter）と Tips を開いて「見る」にフォーカスを移す（もう一度 Enter で移る）。
//   Mobile は 1 回目のタップで Tips、Tips の「見る」のタップで移る。置き物の長押しも Tips（歩かない）。
// - Mobile（767px 以下）は点を重ねず、3D の枠の下端に置き物の名前のボタンを横に並べる（横にスクロール。第 1 版と同じ。計画 Task 6）。
//   画角が狭く、道の左右の置き物は画面に入らないため（置き物の点に重ねる形では押せない置き物が出る）。Tips は枠の下端の札。
// - 閉じ方: Escape（押したボタンへフォーカスを戻す）・外側を押す（戻さない。第 1 版の最終レビュー I-1）・ヒーローが画面から外れる・閉じるボタン。
// - Tips が開いている間は歩かない（Review Focus 1。onOpenChange で島に伝える）。
// perf: 位置は React の再描画をせず、ref で transform を書く。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { layoutMarkers, type MarkerPoint } from "../lib/markers";
import type { AtelierScene, PickId } from "../lib/scene";
import type { Phase } from "../lib/types";
import AtelierTips, { type AtelierTipView } from "../components/AtelierTips";

export interface AtelierTouchItem {
  /** 置き物の PropId か frame:<n> */
  id: PickId;
  heading: string;
  body: string;
  cta: string;
  href: string;
  /** 移り先の冒頭の静止画（時間帯ごと） */
  images: Record<Phase, string>;
}

export interface AtelierTouchCopy {
  close: string;
  /** 押せるボタンの群れの名前 */
  groupLabel: string;
  items: readonly AtelierTouchItem[];
}

interface Props {
  copy: AtelierTouchCopy;
  phase: Phase;
  boxRef: RefObject<HTMLDivElement | null>;
  getScene(): AtelierScene | null;
  subscribeFrame(fn: () => void): () => void;
  onOpenChange(open: boolean): void;
}

const MARKER_GAP = 34;
const MARKER_MARGIN = 24;
const TIP_W = 320;
const MOBILE = "(max-width: 767px)";
/** カーソルが置き物・Tips から離れてから閉じるまで（札へ移る途中で閉じない） */
const HOVER_CLOSE_MS = 280;
const LONG_PRESS_MS = 300;

const dataId = (id: PickId) =>
  id.startsWith("frame:")
    ? { "data-atelier-frame": id.slice(6) }
    : { "data-atelier-prop": id };

export default function AtelierTouch({
  copy,
  phase,
  boxRef,
  getScene,
  subscribeFrame,
  onOpenChange,
}: Props) {
  const buttons = useRef(new Map<PickId, HTMLButtonElement>());
  const [hover, setHover] = useState<PickId | null>(null);
  const [open, setOpen] = useState<{
    id: PickId;
    position: { left: number; top: number } | null;
    pinned: boolean;
  } | null>(null);
  const returnTo = useRef<PickId | null>(null);
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const focusLink = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const items = useRef(new Map(copy.items.map((item) => [item.id, item])));
  // 初めの描画から Mobile の並びで出す（false から切り替えると、全面の箱が下端の帯へ移り、レイアウトのずれ〈CLS〉に数えられる）。
  // この部品は準備ができてからクライアントだけで描くので、window を読んでもハイドレーションの食い違いは起きない
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE).matches);
  useEffect(() => {
    const query = window.matchMedia(MOBILE);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  /**
   * ボタンを置く。点はいつも置き物の位置に出す（2026-10-30 ユーザーの指示。以前は文字の板の右へ寄せていて、板に隠れる置き物の点が板の右に縦に並んだ）。
   * 板が見えている間に板に隠れる置き物の点は出さない（カメラが動くと板は隠れ、点が置き物の位置に出る）
   */
  const place = useCallback(() => {
    const box = boxRef.current;
    const scene = getScene();
    if (!box || !scene) return;
    if (window.matchMedia(MOBILE).matches) {
      // Mobile は名前の列（CSS で並べる）。点の位置には置かない
      for (const el of buttons.current.values()) {
        el.hidden = false;
        el.style.transform = "";
      }
      return;
    }
    const w = box.clientWidth;
    const h = box.clientHeight;
    const projected = scene.projectAnchors();
    const b = box.getBoundingClientRect();
    const panelEl = window.matchMedia(MOBILE).matches
      ? null
      : box
          .closest("[data-atelier-hero]")
          ?.querySelector(".atelier-hero__copy");
    // 板が見えているか（隠す途中の半透明も、半分を超えて残っている間は見えているとみなす）
    const panelShown = !!panelEl && Number(getComputedStyle(panelEl).opacity) > 0.5;
    const pr = panelShown ? panelEl!.getBoundingClientRect() : undefined;
    const panel = pr
      ? {
          left: pr.left - b.left - 12,
          right: pr.right - b.left + 12,
          top: pr.top - b.top - 12,
          bottom: pr.bottom - b.top + 12,
        }
      : null;
    const points: MarkerPoint[] = [];
    for (const [id, el] of buttons.current) {
      const p = projected.get(id);
      const underPanel =
        !!p &&
        !!panel &&
        p.x >= panel.left &&
        p.x <= panel.right &&
        p.y >= panel.top &&
        p.y <= panel.bottom;
      el.hidden = !p?.visible || underPanel;
      if (el.hidden) continue;
      points.push({ id, x: p!.x, y: p!.y });
    }
    for (const m of layoutMarkers(points, {
      width: w,
      height: h,
      margin: MARKER_MARGIN,
      minGap: MARKER_GAP,
    })) {
      const el = buttons.current.get(m.id as PickId);
      if (el)
        el.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px)`;
    }
  }, [boxRef, getScene]);

  useEffect(() => {
    place();
    const off = subscribeFrame(place);
    const box = boxRef.current;
    const observer = box ? new ResizeObserver(() => place()) : null;
    if (box) observer?.observe(box);
    return () => {
      off();
      observer?.disconnect();
    };
  }, [place, subscribeFrame, boxRef, mobile]);

  // 縁の光（立体）と、根の data-atelier-hover（CSS・e2e が読む）
  useEffect(() => {
    const id = hover ?? open?.id ?? null;
    getScene()?.setHover(id);
    const host = boxRef.current?.closest<HTMLElement>(
      '[data-motion="atelier"]',
    );
    if (!host) return;
    if (id) host.setAttribute("data-atelier-hover", id);
    else host.removeAttribute("data-atelier-hover");
  }, [hover, open, getScene, boxRef]);

  useEffect(() => onOpenChange(open !== null), [open, onOpenChange]);

  // 開いたら「見る」にフォーカスを移す（押して開いたときだけ。カーソルを乗せて開いたときは移さない）
  useEffect(() => {
    if (open && focusLink.current) {
      focusLink.current = false;
      linkRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  const positionFor = useCallback(
    (id: PickId) => {
      const box = boxRef.current;
      const el = buttons.current.get(id);
      if (!box || !el || window.matchMedia(MOBILE).matches) return null;
      const b = box.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2 - b.left;
      const y = r.top + r.height / 2 - b.top;
      const left = x > b.width * 0.55 ? x - 28 - TIP_W : x + 28;
      return {
        left: Math.max(8, Math.min(left, b.width - TIP_W - 8)),
        top: Math.max(8, Math.min(y - 60, b.height - 400)),
      };
    },
    [boxRef],
  );

  const openTip = useCallback(
    (id: PickId, how: "hover" | "press") => {
      window.clearTimeout(closeTimer.current);
      if (how === "press") {
        returnTo.current = id;
        focusLink.current = true;
      }
      setOpen((cur) =>
        cur?.id === id && cur.pinned && how === "hover"
          ? cur
          : { id, position: positionFor(id), pinned: how === "press" },
      );
    },
    [positionFor],
  );

  /**
   * 閉じる。フォーカスを押したボタンへ戻すのは、閉じる直前のフォーカスが Tips の中か body にあったときだけ
   * （外側を押して閉じたときは、押した先のフォーカスを尊重する）。戻すときも画面を動かさない（preventScroll。第 1 版の I-1）
   */
  const close = useCallback((restoreFocus: boolean) => {
    window.clearTimeout(closeTimer.current);
    const active = document.activeElement;
    const fromTips =
      !active ||
      active === document.body ||
      !!active.closest("[data-atelier-tips]");
    setOpen(null);
    const id = returnTo.current;
    returnTo.current = null;
    if (id && restoreFocus && fromTips)
      buttons.current.get(id)?.focus({ preventScroll: true });
  }, []);

  const scheduleHoverClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(
      () => setOpen((cur) => (cur && !cur.pinned ? null : cur)),
      HOVER_CLOSE_MS,
    );
  }, []);
  const keepOpen = useCallback(
    () => window.clearTimeout(closeTimer.current),
    [],
  );

  // ブラウザーの「戻る」（bfcache）で帰ってきたら、開いていた Tips を閉じる（Review Focus 4）
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        returnTo.current = null;
        setOpen(null);
        setHover(null);
      }
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // Escape・外側を押す・ヒーローが画面から外れると閉じる
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest(
          "[data-atelier-tips], [data-atelier-prop], [data-atelier-frame]",
        )
      )
        return;
      // canvas の置き物を押した（タップした）ときは、その置き物の Tips に替える（閉じない）
      const box = boxRef.current;
      if (box && target && box.parentElement?.contains(target)) {
        const r = box.getBoundingClientRect();
        const id =
          getScene()?.pick(event.clientX - r.left, event.clientY - r.top) ??
          null;
        if (id && items.current.has(id)) return;
      }
      close(false);
    };
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
  }, [open, close, boxRef, getScene]);

  // canvas の置き物にカーソルを乗せる・押す・長押しする。canvas は文字の後ろにあるので、ヒーローの区画で受けて pick する
  useEffect(() => {
    const box = boxRef.current;
    const hero = box?.closest<HTMLElement>("[data-atelier-hero]");
    if (!box || !hero) return undefined;
    // 3D の根（canvas・ポスター。箱〈atelier__box〉は pointer-events: none なので、イベントの target にならない）
    const scene3d = box.closest<HTMLElement>('[data-motion="atelier"]');
    let picked: PickId | null = null;
    let press: { id: PickId; timer: number } | null = null;
    const pickAt = (event: PointerEvent | MouseEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest(
          "a, button, input, [data-atelier-ui], .atelier-hero__copy",
        )
      )
        return null;
      const r = box.getBoundingClientRect();
      const x = event.clientX - r.left;
      const y = event.clientY - r.top;
      // 3D の箱の外（1279px 以下の文字のまわりの余白）では拾わない（箱の外の光線が見えていない置き物に当たる。最終レビュー I-1）
      if (x < 0 || y < 0 || x >= r.width || y >= r.height || !target || !scene3d?.contains(target)) return null;
      const id = getScene()?.pick(x, y) ?? null;
      return id && items.current.has(id) ? id : null;
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const id = pickAt(event);
      if (id === picked) return;
      picked = id;
      hero.style.cursor = id ? "pointer" : "";
      if (id) openTip(id, "hover");
      else scheduleHoverClose();
    };
    const onLeave = () => {
      picked = null;
      hero.style.cursor = "";
      scheduleHoverClose();
    };
    const onClick = (event: MouseEvent) => {
      const id = pickAt(event);
      if (id) openTip(id, "press");
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const target = event.target as Element | null;
      const fromButton = target?.closest<HTMLElement>(
        "[data-atelier-prop], [data-atelier-frame]",
      );
      const id: PickId | null = fromButton
        ? ((fromButton.dataset.atelierProp ??
            `frame:${fromButton.dataset.atelierFrame}`) as PickId)
        : pickAt(event);
      if (!id || !items.current.has(id)) return;
      press = {
        id,
        timer: window.setTimeout(() => openTip(id, "press"), LONG_PRESS_MS),
      };
    };
    const onUp = () => {
      if (press) window.clearTimeout(press.timer);
      press = null;
    };
    hero.addEventListener("pointermove", onMove);
    hero.addEventListener("pointerleave", onLeave);
    hero.addEventListener("click", onClick);
    hero.addEventListener("pointerdown", onDown);
    hero.addEventListener("pointerup", onUp);
    hero.addEventListener("pointercancel", onUp);
    return () => {
      onUp();
      hero.style.cursor = "";
      hero.removeEventListener("pointermove", onMove);
      hero.removeEventListener("pointerleave", onLeave);
      hero.removeEventListener("click", onClick);
      hero.removeEventListener("pointerdown", onDown);
      hero.removeEventListener("pointerup", onUp);
      hero.removeEventListener("pointercancel", onUp);
    };
  }, [boxRef, getScene, openTip, scheduleHoverClose]);

  const openItem = open ? items.current.get(open.id) : undefined;
  const tip: AtelierTipView | null = openItem
    ? {
        id: openItem.id,
        heading: openItem.heading,
        body: openItem.body,
        cta: openItem.cta,
        href: openItem.href,
        image: openItem.images[phase],
      }
    : null;

  return (
    <>
      <div
        role="group"
        aria-label={copy.groupLabel}
        className={
          mobile ? "atelier-points atelier-points--list" : "atelier-points"
        }
      >
        {copy.items.map((item) => (
          <button
            key={item.id}
            type="button"
            {...dataId(item.id)}
            ref={(el) => {
              if (el) buttons.current.set(item.id, el);
              else buttons.current.delete(item.id);
            }}
            aria-expanded={open?.id === item.id}
            aria-haspopup="dialog"
            onPointerEnter={(event) => {
              setHover(item.id);
              if (event.pointerType === "mouse") openTip(item.id, "hover");
            }}
            onPointerLeave={(event) => {
              setHover((h) => (h === item.id ? null : h));
              if (event.pointerType === "mouse") scheduleHoverClose();
            }}
            onFocus={() => setHover(item.id)}
            onBlur={() => setHover((h) => (h === item.id ? null : h))}
            onClick={() =>
              open?.id === item.id && open.pinned
                ? close(true)
                : openTip(item.id, "press")
            }
            className="atelier-point"
          >
            <span aria-hidden="true" className="atelier-point__dot" />
            <span className="atelier-point__label type-small">
              {item.heading}
            </span>
          </button>
        ))}
      </div>
      {tip && open && (
        <AtelierTips
          tip={tip}
          closeLabel={copy.close}
          position={open.position}
          linkRef={linkRef}
          onClose={() => close(true)}
          onPointerEnter={keepOpen}
          onPointerLeave={scheduleHoverClose}
        />
      )}
    </>
  );
}
