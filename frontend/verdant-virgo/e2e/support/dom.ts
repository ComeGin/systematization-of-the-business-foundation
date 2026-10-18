// ページの中で評価する DOM の検査（page.evaluate に渡す）。各関数は自己完結させる（外の変数を参照しない）。
import type { Page } from "@playwright/test";

export type FocusStep = {
  /** markTabbables() が振った番号（data-e2e-tab）。番号の無い要素は -1。iframe の中にいる間は iframe の番号 */
  index: number;
  tag: string;
  label: string;
  outline: string;
  boxShadow: string;
  /** outline か box-shadow でフォーカスが見えるか */
  visible: boolean;
  /** Cookie バナーにすっかり隠れているか（WCAG 2.2 の 2.4.11） */
  hiddenByBanner: boolean;
};

/**
 * Tab で届くはずの要素に、DOM の順で番号（data-e2e-tab）を振って数を返す。
 * 見えない・無効・inert・tabindex が負の要素と、閉じた <dialog>・hidden の中は除く。
 */
export function markTabbables(page: Page): Promise<number> {
  return page.evaluate(() => {
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, iframe, [tabindex], [contenteditable="true"], summary';
    const all = [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (el) => {
        if (el.matches(":disabled")) return false;
        if (el.closest("[inert], [hidden], dialog:not([open])")) return false;
        if (el.tabIndex < 0) return false;
        if (!el.checkVisibility({ visibilityProperty: true })) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
    );
    // ラジオは同じ name の組で 1 つだけ Tab で届く（選択済みか、無ければ先頭）
    const radios = new Set<string>();
    const tabbables = all.filter((el) => {
      if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name)
        return true;
      if (radios.has(el.name)) return false;
      radios.add(el.name);
      return true;
    });
    document
      .querySelectorAll("[data-e2e-tab]")
      .forEach((el) => el.removeAttribute("data-e2e-tab"));
    tabbables.forEach((el, i) => el.setAttribute("data-e2e-tab", String(i)));
    return tabbables.length;
  });
}

/** 今フォーカスしている要素の様子 */
export function focusStep(page: Page): Promise<FocusStep | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement)
      return null;
    const style = getComputedStyle(el);
    const outlineWidth = Number.parseFloat(style.outlineWidth) || 0;
    const outlineShown = style.outlineStyle !== "none" && outlineWidth > 0;
    const shadowShown = style.boxShadow !== "none" && style.boxShadow !== "";
    const banner = document.getElementById("cookie-banner");
    let hiddenByBanner = false;
    if (banner && !banner.hidden && !banner.contains(el)) {
      const a = el.getBoundingClientRect();
      const b = banner.getBoundingClientRect();
      hiddenByBanner =
        a.width > 0 &&
        a.height > 0 &&
        a.left >= b.left &&
        a.right <= b.right &&
        a.top >= b.top &&
        a.bottom <= b.bottom;
    }
    const raw = el.getAttribute("data-e2e-tab");
    return {
      index: raw === null ? -1 : Number(raw),
      tag: el.tagName.toLowerCase(),
      label: (el.getAttribute("aria-label") ?? el.textContent ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40),
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      boxShadow: style.boxShadow.slice(0, 60),
      visible: outlineShown || shadowShown,
      hiddenByBanner,
    };
  });
}

/**
 * Tab（reverse なら Shift+Tab）を押し続け、フォーカスが移った先を順に返す。
 * ページの外（アドレスバー）へ出るか、最初の要素に戻ったら止める。iframe に入ったら、出てくるまで押し続ける。
 */
export async function walkFocus(
  page: Page,
  max: number,
  reverse = false,
): Promise<FocusStep[]> {
  const key = reverse ? "Shift+Tab" : "Tab";
  const steps: FocusStep[] = [];
  let first: number | null = null;
  // iframe（Cal.com）の中は何十回も Tab が要るので、max とは別の上限で数える
  let insideFrame = 0;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key);
    const step = await focusStep(page);
    if (!step) {
      if (steps.length > 0) break; // ページの外へ出た
      continue;
    }
    if (step.index === -1 && step.tag !== "iframe") continue;
    if (step.tag === "iframe") {
      if (steps.at(-1)?.tag !== "iframe") steps.push(step);
      if (++insideFrame < 300) i--;
      continue;
    }
    if (first === null) first = step.index;
    else if (step.index === first) break; // 一周した
    if (steps.at(-1)?.index === step.index) continue;
    steps.push(step);
  }
  return steps;
}

export type Heading = { level: number; text: string };

/**
 * 支援技術に出る見出し（sr-only を含む。display:none・aria-hidden・閉じた dialog の中は除く）。
 * exclude に合う要素の中の見出しも除く（表示中の Cookie バナーなど）。
 */
export function headings(page: Page, exclude?: string): Promise<Heading[]> {
  return page.evaluate((exclude) =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "h1, h2, h3, h4, h5, h6, [role=heading]",
      ),
    ]
      .filter(
        (h) =>
          h.checkVisibility({ visibilityProperty: true }) &&
          !h.closest('[aria-hidden="true"], dialog:not([open]), [hidden]') &&
          !(exclude && h.closest(exclude)),
      )
      .map((h) => ({
        level: Number(h.getAttribute("aria-level") ?? h.tagName.slice(1)),
        text: (h.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
      })),
  exclude);
}

/** 見出しの段の飛び（h2 の次に h4 など）を「前 → 後」の文で返す */
export function headingSkips(list: Heading[]): string[] {
  const skips: string[] = [];
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const next = list[i];
    if (next.level > prev.level + 1) {
      skips.push(
        `h${prev.level}「${prev.text}」→ h${next.level}「${next.text}」`,
      );
    }
  }
  return skips;
}

export type Landmark = { role: string; name: string };

/** 見えているランドマーク（役割と名前） */
export function landmarks(page: Page): Promise<Landmark[]> {
  return page.evaluate(() => {
    const nameOf = (el: Element) => {
      const ids = el.getAttribute("aria-labelledby");
      if (ids) {
        return ids
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ")
          .trim();
      }
      return el.getAttribute("aria-label")?.trim() ?? "";
    };
    const sectioning = "article, aside, main, nav, section";
    const roleOf = (el: Element): string | null => {
      const explicit = el.getAttribute("role");
      if (explicit) {
        return [
          "banner",
          "complementary",
          "contentinfo",
          "form",
          "main",
          "navigation",
          "region",
          "search",
        ].includes(explicit)
          ? explicit
          : null;
      }
      switch (el.tagName) {
        case "MAIN":
          return "main";
        case "NAV":
          return "navigation";
        case "ASIDE":
          return "complementary";
        case "HEADER":
          return el.parentElement?.closest(sectioning) ? null : "banner";
        case "FOOTER":
          return el.parentElement?.closest(sectioning) ? null : "contentinfo";
        case "SECTION":
          return nameOf(el) ? "region" : null;
        case "FORM":
          return nameOf(el) ? "form" : null;
        case "SEARCH":
          return "search";
        default:
          return null;
      }
    };
    return [
      ...document.querySelectorAll(
        "main, nav, aside, header, footer, section, form, search, [role]",
      ),
    ]
      .filter(
        (el) =>
          (el as HTMLElement).checkVisibility({ visibilityProperty: true }) &&
          !el.closest('[aria-hidden="true"], dialog:not([open]), [hidden]'),
      )
      .map((el) => ({ role: roleOf(el), name: nameOf(el) }))
      .filter((l): l is { role: string; name: string } => l.role !== null);
  });
}

/** 役割と名前の組が重なるランドマーク（main・banner・contentinfo は 1 つだけのはずなので名前が無くても重複として数える） */
export function duplicateLandmarks(list: Landmark[]): string[] {
  const count = new Map<string, number>();
  for (const l of list) {
    const key = `${l.role}「${l.name}」`;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return [...count].filter(([, n]) => n > 1).map(([key, n]) => `${key} × ${n}`);
}

/** target="_blank" のうち、読み上げの文（中身・aria-label・aria-describedby）に新しいタブの告知が無いもの */
export function newTabLinksWithoutNotice(
  page: Page,
  notice: RegExp,
): Promise<string[]> {
  return page.evaluate(
    ({ source, flags }) => {
      const re = new RegExp(source, flags);
      return [
        ...document.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]'),
      ]
        .filter((a) => !a.closest('[aria-hidden="true"]'))
        .filter((a) => {
          const described = (a.getAttribute("aria-describedby") ?? "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
          const text = `${a.textContent ?? ""} ${a.getAttribute("aria-label") ?? ""} ${a.getAttribute("title") ?? ""} ${described}`;
          return !re.test(text);
        })
        .map(
          (a) =>
            `${(a.textContent ?? "").trim().slice(0, 30)} → ${a.getAttribute("href")}`,
        );
    },
    { source: notice.source, flags: notice.flags },
  );
}

/** title が無い・空の iframe（src の先頭） */
export function iframesWithoutTitle(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("iframe")]
      .filter((f) => !(f.getAttribute("title") ?? "").trim())
      .map((f) => (f.getAttribute("src") ?? "(src なし)").slice(0, 60)),
  );
}

/** 横スクロールが出ているか（ページの幅が表示の幅を 1px より超える） */
export function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  });
}

/**
 * 文字が切れている要素（overflow が hidden・clip で、中身が箱より大きい。sr-only の 1px の箱は除く）。
 * text-overflow: ellipsis・line-clamp の切り詰めもここで見つかる。
 */
export function clippedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      if (
        el.closest(
          '[aria-hidden="true"], dialog:not([open]), [hidden], iframe, svg, canvas',
        )
      )
        continue;
      const style = getComputedStyle(el);
      const clipsX = ["hidden", "clip"].includes(style.overflowX);
      const clipsY = ["hidden", "clip"].includes(style.overflowY);
      if (!clipsX && !clipsY) continue;
      // sr-only（1px の箱か、clip で隠す。スキップリンクのように余白で箱が広がっても clip は残る）
      if (el.clientWidth <= 1 || el.clientHeight <= 1) continue;
      if (
        style.clip === "rect(0px, 0px, 0px, 0px)" ||
        style.clipPath === "inset(50%)"
      )
        continue;
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
      );
      if (
        !hasText &&
        !el.querySelector("p, span, a, li, h1, h2, h3, h4, h5, h6")
      )
        continue;
      const overX = clipsX && el.scrollWidth > el.clientWidth + 1;
      const overY = clipsY && el.scrollHeight > el.clientHeight + 1;
      if (overX || overY) {
        const name = `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join(".")}`;
        out.push(
          `${name}「${(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30)}」`,
        );
      }
    }
    return [...new Set(out)];
  });
}

/** 時間が 10ms を超える transition・animation を持つ要素（reduced-motion のとき 0 のはず） */
export function longMotions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seconds = (list: string) =>
      Math.max(
        0,
        ...list.split(",").map((v) => {
          const t = v.trim();
          return t.endsWith("ms")
            ? Number.parseFloat(t) / 1000
            : Number.parseFloat(t) || 0;
        }),
      );
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(el);
      const transition =
        style.transitionProperty !== "none"
          ? seconds(style.transitionDuration)
          : 0;
      const animation =
        style.animationName !== "none" ? seconds(style.animationDuration) : 0;
      if (transition > 0.01 || animation > 0.01) {
        out.push(
          `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join(".")} transition=${style.transitionDuration} animation=${style.animationName}/${style.animationDuration}`,
        );
      }
    }
    return [...new Set(out)];
  });
}

/** 1.4.12 の文字の間隔（行の高さ 1.5、段落の後 2 倍、字間 0.12、語間 0.16）を全体に当てる */
export const TEXT_SPACING_CSS = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

/**
 * 今フォーカスしている要素が、生きた領域（role=alert・status・aria-live）の中か。
 * フォーカスの移動と生きた領域の両方で同じ通知を出すと、二重に読み上げられる（計画書の I1）。
 */
export function focusInsideLiveRegion(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return !!el?.closest(
      '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]',
    );
  });
}

/** 生きた領域（role=alert・status・aria-live）のうち、文字が入っているものの中身 */
export function liveRegionTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]',
      ),
    ]
      .filter((el) => el.getAttribute("aria-live") !== "off")
      .map((el) => (el.textContent ?? "").trim().replace(/\s+/g, " "))
      .filter(Boolean),
  );
}

/**
 * 走っている CSS の transition・animation（有限のもの）が終わるまで待つ。
 * 水和で送信ボタンが無効から有効に替わる途中や、Mobile メニューが開く途中を測らないため。
 * 無限に繰り返すもの（Spinner など）は待たない。上限 2 秒。
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (a) =>
              a.playState !== "running" ||
              a.effect?.getComputedTiming().iterations === Infinity,
          ),
      undefined,
      { timeout: 2_000 },
    )
    .catch(() => {});
}
