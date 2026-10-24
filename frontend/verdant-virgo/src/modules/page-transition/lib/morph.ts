// ページ移動の形のつながり（文書間の View Transitions）の名前の付け方。判定（パスの分類）と DOM の名付けを 1 か所に置く。
//
// なぜ 1 つの関数（createMorph）に閉じているか:
//   戻るときの名付け（pagereveal）は最初の描画より前に登録しないと取りこぼすので、<head> の classic の inline script で行う
//   （Astro の <script> は type=module で遅延実行になり、間に合わない）。inline の script は TS を import できない。
//   そこで判定と名付けをすべて createMorph の中に閉じ（外の束縛を参照しない）、ビルド時に関数の文字列（toString）として head に埋める。
//   pageswap（module の script）・単体テスト・head の inline は、どれも同じ createMorph を呼ぶ。判定が 2 か所に分かれない。
//   C のページ（/legal/）の判定は rules.ts の isStillPath・shouldSkipTransition を、同じく文字列にして渡す（pageRevealScript）。
//
// 名付けの規則:
//   - 遷移先のページは、対応する要素に名前を静的に持つ（サービス詳細の h1、記事の h1 とアイキャッチ、お問い合わせの h1。names.ts の vtStyle）。
//   - 遷移元のページは pageswap で、行き先に一致する a[href] を含むカード（[data-morph-source]）の中の [data-morph] にだけ名前を付ける。
//     押したリンクがカードの中ならそのカード、無ければ最初に一致したカード（1 ページに同じ名前を 2 つ作らない）。
//     CTA（[data-cta-id]）で行き先が /contact/ のときは、押したボタン自身に vt-contact-title を付ける。
//   - 戻るとき（行き先のページに、移動元へのカードがあるとき）は pagereveal で、移動元に一致するカードに名前を付ける。
//     ただし行き先のページが自分でも同じ種類の名前を持つとき（記事 → 記事）は付けない。移動元のカードの側（pageswap）が付けるので、取り合いになる。
//   - 名前を付ける前に、同じ名前をすでに持つ要素（静的な h1 など）の名前を none にする。同じ名前が 2 つあると遷移全体が中止される。
//   - 付けた名前・外した名前は data-vt-set・data-vt-cleared で印を付け、次の pageswap・pagereveal（と遷移の終わり）で元に戻す（bfcache で戻ったときに残さない）。
//   - 移動元か移動先が C のページなら skipTransition()。C のページは @view-transition で opt-in していないので遷移はそもそも起きない（二重の守り）。
import { VT, type VtMap, type VtName } from "./names";
import { isStillPath, shouldSkipTransition } from "./rules";

type ShouldSkip = (fromPath: string, toPath: string) => boolean;

/** pageswap・pagereveal のうち、ここで使う形だけ（lib.dom の型がまだ無い環境のため） */
type ViewTransitionLike = {
  skipTransition(): void;
  ready: Promise<unknown>;
  finished: Promise<unknown>;
};
type SwapEventLike = Event & {
  viewTransition: ViewTransitionLike | null;
  activation: { entry: { url: string } | null } | null;
};
type RevealEventLike = Event & { viewTransition: ViewTransitionLike | null };
type WindowLike = Window & {
  navigation?: {
    activation?: { from?: { url?: string | null } | null } | null;
  };
};

/**
 * 判定と名付けの一式を作る。外の束縛（import した値など）を参照してはいけない（toString して head に埋めるため）。
 * vt は names.ts の VT、shouldSkip は rules.ts の shouldSkipTransition を渡す。
 */
export function createMorph(vt: VtMap, shouldSkip: ShouldSkip) {
  const SERVICE_DETAIL = /^\/services\/[^/]+\/$/;
  // /blog/page/<n>/・/blog/category/<x>/ は一覧（記事ではない）
  const ARTICLE = /^\/blog\/(?!(?:page|category)\/)[^/]+\/$/;
  const CONTACT = "/contact/";
  // カード（[data-morph-source]）を並べるページ。戻るときの名付けと、最初の描画を待たせるのはここへの移動だけ
  // （トップ・サービス一覧・ブログ一覧・ページ送り・カテゴリ〈とそのページ送り〉）
  const CARD_LIST = /^\/(?:services\/|blog\/(?:page\/[^/]+\/|category\/[^/]+\/(?:page\/[^/]+\/)?)?)?$/;
  // カードの中の [data-morph] の役目ごとに、付けうる名前（行き先の種類で 1 つに決まる）
  const ROLE_NAMES: Record<string, readonly VtName[]> = {
    title: [vt.serviceTitle, vt.articleTitle],
    media: [vt.articleMedia],
  };
  const SET = "data-vt-set";
  const CLEARED = "data-vt-cleared";

  /** パス名だけにし、末尾に / を足す（クエリ・ハッシュは外す）。base は相対の href を解決する基準 */
  function normalizePath(input: string, base?: string): string {
    if (!input) return "";
    let path = new URL(input, base || "http://localhost/").pathname;
    if (!path.endsWith("/")) path += "/";
    return path;
  }

  /** 行き先のパスで、形をつなぐ名前の一覧 */
  function morphTargetsFor(toPath: string): readonly VtName[] {
    const path = normalizePath(toPath);
    if (SERVICE_DETAIL.test(path)) return [vt.serviceTitle];
    if (ARTICLE.test(path)) return [vt.articleTitle, vt.articleMedia];
    if (path === CONTACT) return [vt.contactTitle];
    return [];
  }

  /** 戻るとき（pagereveal）に、行き先のページのカードへ付ける名前。行き先が自分で持つ種類の名前は除く */
  function revealTargetsFor(
    fromPath: string,
    toPath: string,
  ): readonly VtName[] {
    // カードの無いページ（料金・会社概要・お問い合わせなど）では名付けない（待たせもしない）
    if (!CARD_LIST.test(normalizePath(toPath))) return [];
    const own = morphTargetsFor(toPath);
    return morphTargetsFor(fromPath).filter((name) => !own.includes(name));
  }

  /** 前回の名付けを元に戻す */
  function reset(doc: Document) {
    for (const el of Array.from(
      doc.querySelectorAll<HTMLElement>(`[${SET}]`),
    )) {
      el.style.viewTransitionName = "";
      el.removeAttribute(SET);
    }
    for (const el of Array.from(
      doc.querySelectorAll<HTMLElement>(`[${CLEARED}]`),
    )) {
      el.style.viewTransitionName = el.getAttribute(CLEARED) || "";
      el.removeAttribute(CLEARED);
    }
  }

  /** el に name を付ける。同じ名前をすでに持つ要素（静的に持つ h1 など）は先に none にする */
  function assign(doc: Document, el: HTMLElement, name: VtName) {
    for (const other of Array.from(
      doc.querySelectorAll<HTMLElement>('[style*="view-transition-name"]'),
    )) {
      if (other !== el && other.style.viewTransitionName === name) {
        other.setAttribute(CLEARED, name);
        other.style.viewTransitionName = "none";
      }
    }
    el.setAttribute(SET, "");
    el.style.viewTransitionName = name;
  }

  /** a[href] が同じオリジンの path を指すか（末尾の / とクエリ・ハッシュを無視） */
  function pointsTo(
    link: Element | null,
    path: string,
    doc: Document,
  ): link is HTMLAnchorElement {
    if (!link || !link.getAttribute("href")) return false;
    const url = new URL((link as HTMLAnchorElement).href, doc.baseURI);
    return (
      url.origin === doc.location.origin && normalizePath(url.pathname) === path
    );
  }

  /** path へのリンクを含むカード。押したリンク（pressed）がカードの中ならそのカードを優先する */
  function findCard(
    doc: Document,
    path: string,
    pressed: Element | null,
  ): Element | null {
    const own = pressed && pressed.closest("[data-morph-source]");
    if (own && pointsTo(pressed, path, doc)) return own;
    for (const card of Array.from(
      doc.querySelectorAll("[data-morph-source]"),
    )) {
      for (const link of Array.from(card.querySelectorAll("a[href]"))) {
        if (pointsTo(link, path, doc)) return card;
      }
    }
    return null;
  }

  /**
   * targetPath へのカード（と CTA）に names の名前を付ける。付けた要素を返す。
   * pressed は押したリンク（pageswap）。CTA は押したボタン自身にだけ付けるので、pressed が無ければ CTA には付けない。
   */
  function nameSources(
    doc: Document,
    targetPath: string,
    names: readonly VtName[],
    pressed: Element | null,
  ): HTMLElement[] {
    const path = normalizePath(targetPath);
    const named: HTMLElement[] = [];
    if (!path || names.length === 0) return named;
    const card = findCard(doc, path, pressed);
    if (card) {
      for (const el of Array.from(
        card.querySelectorAll<HTMLElement>("[data-morph]"),
      )) {
        const name = (ROLE_NAMES[el.dataset.morph || ""] || []).find((n) =>
          names.includes(n),
        );
        if (
          name &&
          !named.some((done) => done.style.viewTransitionName === name)
        ) {
          assign(doc, el, name);
          named.push(el);
        }
      }
    }
    if (
      names.includes(vt.contactTitle) &&
      pressed &&
      pressed.matches("[data-cta-id]") &&
      pointsTo(pressed, path, doc)
    ) {
      assign(doc, pressed as HTMLElement, vt.contactTitle);
      named.push(pressed as HTMLElement);
    }
    return named;
  }

  /**
   * 遷移を飛ばす。skipTransition() は ready を AbortError で reject するので、先に catch を付ける
   * （付けないと未処理の reject になり、PostHog の例外の監視に誤った例外として送られる）。
   */
  function skip(transition: ViewTransitionLike) {
    const ignore = () => {};
    transition.ready.catch(ignore);
    transition.finished.catch(ignore);
    transition.skipTransition();
  }

  /** 遷移元のページ: 押したリンクを覚え、pageswap で行き先に一致するカード・CTA に名前を付ける（module の script から呼ぶ） */
  function installSwap(win: WindowLike) {
    let pressed: Element | null = null;
    win.document.addEventListener(
      "click",
      (event) => {
        const target = event.target as Element | null;
        pressed = target && target.closest ? target.closest("a[href]") : null;
      },
      true,
    );
    win.addEventListener("pageswap", (raw) => {
      const event = raw as SwapEventLike;
      const doc = win.document;
      reset(doc);
      const transition = event.viewTransition;
      const entry = event.activation && event.activation.entry;
      if (!transition || !entry || !entry.url) return;
      const from = win.location.pathname;
      const to = new URL(entry.url).pathname;
      if (shouldSkip(from, to)) {
        skip(transition);
        return;
      }
      nameSources(doc, to, morphTargetsFor(to), pressed);
    });
  }

  /** 行き先のページ: pagereveal で、移動元に一致するカードに名前を付ける（head の inline script から呼ぶ。最初の描画より前に登録する） */
  function installReveal(win: WindowLike, expectId?: string) {
    // 戻るときに名前を付けるカードは本文の中にある。pagereveal は最初の描画の直前に起きるので、
    // 負荷が高く HTML の解析がカードまで進んでいないと、カードが見つからない（2026-10-19 の pnpm a11y で再現）。
    // 名前を付けうる移動（移動元が詳細・記事で、このページがカードを並べるページ）のときだけ、
    // <link rel="expect" blocking="render"> で本文を読み終えるまで最初の描画を待たせる。待つ先は本文の後ろの要素（#expectId。フッター）。
    // #main を指すと、負荷の高いときに本文の開始タグの時点で描画が始まり、カードが間に合わなかった（2026-10-19 の e2e で再現）。
    // head の解析中（body がまだ無い）に足すので、描画を止める要素として扱われる。普段の訪問（移動元が無い）と、
    // reduced-motion（形のつながりが動かないので待つ意味が無い）には足さない。
    const first = win.navigation && win.navigation.activation;
    const firstFrom = first && first.from && first.from.url;
    const reduced = !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (expectId && firstFrom && !reduced && win.document && win.document.head) {
      const fromPath = new URL(firstFrom).pathname;
      const toPath = win.location.pathname;
      if (!shouldSkip(fromPath, toPath) && revealTargetsFor(fromPath, toPath).length > 0) {
        const link = win.document.createElement("link");
        link.rel = "expect";
        link.href = `#${expectId}`;
        link.setAttribute("blocking", "render");
        win.document.head.appendChild(link);
      }
    }
    win.addEventListener("pagereveal", (raw) => {
      const event = raw as RevealEventLike;
      const doc = win.document;
      reset(doc);
      const transition = event.viewTransition;
      if (!transition) return;
      const activation = win.navigation && win.navigation.activation;
      const fromUrl = activation && activation.from && activation.from.url;
      if (!fromUrl) return;
      const from = new URL(fromUrl).pathname;
      const to = win.location.pathname;
      if (shouldSkip(from, to)) {
        skip(transition);
        return;
      }
      nameSources(doc, from, revealTargetsFor(from, to), null);
      const done = () => reset(doc);
      transition.finished.then(done, done);
    });
  }

  return {
    normalizePath,
    morphTargetsFor,
    revealTargetsFor,
    nameSources,
    reset,
    installSwap,
    installReveal,
  };
}

const morph = createMorph(VT, shouldSkipTransition);

/** パス名だけにし、末尾に / を足す（クエリ・ハッシュは外す） */
export const normalizePath = (input: string): string =>
  morph.normalizePath(input);

/**
 * 行き先のパスで、形をつなぐ名前の一覧。
 * /services/<slug>/ → [serviceTitle]、/blog/<slug>/（page・category を除く）→ [articleTitle, articleMedia]、/contact/ → [contactTitle]、それ以外 → []
 */
export const morphTargetsFor = (toPath: string): readonly VtName[] =>
  morph.morphTargetsFor(toPath);

/** 遷移元のページで pageswap を登録する（PageTransition.astro の module の script） */
export const installPageSwap = (win: Window): void => morph.installSwap(win);

/**
 * head の classic の inline script の中身（pagereveal の登録）。import を使わず、それだけで評価できる文字列。
 * 判定は createMorph・shouldSkipTransition・isStillPath の実装をそのまま文字列にしたもの（2 か所に書かない）。
 */
/** 関数の文字列から /** … *\/ の説明のコメントを落とす（全ページの head に入るので軽くする。// の行コメントは残す） */
const stripDocComments = (source: string): string => source.replace(/[ \t]*\/\*\*[\s\S]*?\*\/\n?/g, "");

export function pageRevealScript(): string {
  return [
    "(function () {",
    isStillPath.toString(),
    shouldSkipTransition.toString(),
    `(${stripDocComments(createMorph.toString())})(${JSON.stringify(VT)}, ${shouldSkipTransition.name}).installReveal(window, "site-footer");`,
    "})();",
  ].join("\n");
}
