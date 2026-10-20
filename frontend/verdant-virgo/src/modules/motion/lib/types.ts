// motion モジュールの型（契約）。計画書の「インタラクションデザイン」と動きの規則 1〜8。
// 文言の既定値は持たない（03-handoff.md H-16）。文言は site-content から渡す。
import type { PhotoKey } from "@/modules/media";
import type { BreakableHeading } from "@/modules/marketing-ui";

/** MotionNav に渡すナビの項目。current は layout の currentState() の値をそのまま渡す */
export interface MotionNavLink {
  label: string;
  href: string;
  /** そのページなら 'page'、配下のページなら 'true'（aria-current の値） */
  current?: "page" | "true";
}

export interface MotionNavProps {
  links: MotionNavLink[];
  /** nav のランドマークの名前（既存の「メイン」） */
  label: string;
  /**
   * false なら水和しない（SSR と同じ印の静的な <nav> だけを出し、React も形の動きも読まない）。
   * C（none）のページのヘッダーで使う（R20）。既定は true（Desktop だけ水和）
   */
  interactive?: boolean;
}

/** MorphGallery の 1 枚。写真は media の PHOTOS から選び、label は見えるラベル（ラジオの名前） */
export interface MorphGalleryItem {
  photo: PhotoKey;
  label: string;
}

export interface MorphGalleryProps {
  items: MorphGalleryItem[];
  /** ラジオのグループの名前にする見出しの id（新しい文言を足さない） */
  labelledby: string;
  class?: string;
}

export interface MotionSymbolProps {
  /** 置く面。dark は navy の地の上（白いシンボルにする）。既定は light（ネイビーのシンボル） */
  tone?: "light" | "dark";
  class?: string;
}

export interface MotionBlobsProps {
  /** MotionPause の名前（動いている間）。文言は site-content から */
  pauseLabel: string;
  /** MotionPause の名前（止まっている間） */
  resumeLabel: string;
  /** 一時停止のボタンの対象名（site-content の MOTION_PAUSE_TARGETS.cta） */
  pauseTarget: string;
  /**
   * true のとき、自前の一時停止のボタンを出さず、最寄りの [data-motion-paused]（CTA バナーの aside。CtaGlow の MotionPauseFor が付け外しする）に従って止まる。
   * A の CTA は CtaGlow のボタン 1 つで光の縁と粒の両方を止めるため。B の CTA は渡さない（今までどおり粒のボタン）
   */
  externalPause?: boolean;
  class?: string;
}

/**
 * MotionPauseFor。target の id の要素に data-motion-paused="true"|"false" を付け外しする一時停止ボタン。
 * 5 秒を超えて自動で動く部品を包む要素に id を付け、その id を target に渡す。
 */
export interface MotionPauseForProps {
  /** 止める対象の要素の id（# は付けない） */
  target: string;
  /** sessionStorage のキー（部品ごとに別。例: motion:globe） */
  storageKey: string;
  /** 動いている間の名前。文言は site-content の MOTION_PAUSE */
  pauseLabel: string;
  /** 止まっている間の名前 */
  resumeLabel: string;
  /** 置く面。dark は反転面（navy.700）の上 */
  tone?: "light" | "dark";
  /** 対象名（MotionPause の target。sr-only で名前に足す。site-content の MOTION_PAUSE_TARGETS）。target（要素の id）とは別 */
  targetName?: string;
  class?: string;
}

/** A（vivid）のヒーローの地。navy.900 の上のグリッド・スポットライト・光の筋と、右下の一時停止のボタン */
export interface HeroBackdropProps {
  /** MotionPause の名前（動いている間）。文言は site-content の MOTION_PAUSE */
  pauseLabel: string;
  /** MotionPause の名前（止まっている間） */
  resumeLabel: string;
  /** 一時停止のボタンの対象名（site-content の MOTION_PAUSE_TARGETS.hero） */
  pauseTarget: string;
  class?: string;
}

/**
 * A（vivid）のヒーローの h1。文字が焦点を結ぶ（CSS だけ）。
 * heading を渡すと区間（segments）ごとに行として順に合い、渡さないと slot の見出し全体に 1 つの動き。
 */
export interface HeroHeadingProps {
  level: "h1";
  /** 改行位置の指定がある見出し（BreakableHeading）。渡すと行ごとに順に焦点が合う */
  heading?: BreakableHeading;
  id?: string;
  /** ページ移動の形のつながりの名前（page-transition の VT）。h1 に静的に付ける */
  viewTransitionName?: string;
  class?: string;
}

/** A（vivid）の Feature Sections。子の [data-glow-card] に、ポインターに沿う光の縁を出す（grid の class は呼び出し側が渡す） */
export interface GlowGridProps {
  class?: string;
}

/** A（vivid）の 3D Card Effect。slot に 1 枚のカードを置く。ポインターで傾き、キーボードのフォーカスでは傾けず浮く */
export interface Tilt3dProps {
  /** 傾きの最大（度）。既定 8 */
  maxDeg?: number;
  class?: string;
}

/**
 * A（vivid）の 3D Marquee（トップ 1-6「使うツール」）。今の文字のバッジを、傾いた面に 3 本の流れで見せる。
 * 読み上げ用の一覧（<ul>）を 1 つだけ持ち、流れる複製は aria-hidden かつ inert。ロゴは足さない。
 */
export interface ToolMarqueeProps {
  /** バッジの文字（site-content の TOP.tools.badges をそのまま渡す） */
  items: readonly string[];
  /** MotionPause の名前（動いている間）。文言は site-content の MOTION_PAUSE */
  pauseLabel: string;
  /** MotionPause の名前（止まっている間） */
  resumeLabel: string;
  /** 一時停止のボタンの対象名（site-content の MOTION_PAUSE_TARGETS.marquee） */
  pauseTarget: string;
  class?: string;
}

/** A（vivid）の 3D Animated Pin。slot に 1 枚のカードを置く。hover とフォーカスでカードが奥へ倒れ、上にピンが立つ（CSS だけ） */
export interface Pin3dProps {
  class?: string;
}

/** A（vivid）の Stats Sections。slot に StatCard 群を置く（grid の class は呼び出し側が渡す）。カードが画面に入ると順に現れ、値の下の罫が引かれる */
export interface StatRowProps {
  class?: string;
}

/** 送信の状態。失敗は 'idle' に戻す（形はチェックにしない。読み上げは既存の Alert に任せる） */
export type SendStatusState = "idle" | "sending" | "done";

/** ボタンの中に置く形だけの部品（aria-hidden）。Spinner と差し替える */
export interface SendStatusMarkProps {
  state: SendStatusState;
  className?: string;
}

/** ボタンの外に置く sr-only の role="status"。送信中だけ 1 回読ませる（done は読まない） */
export interface SendStatusAnnouncerProps {
  state: SendStatusState;
  /** 既存の「送信中…」（CONSULT_TEXT.submitting など） */
  sendingText: string;
}

/**
 * A（vivid）の 3D Globe（サービス一覧の導入ヒーロー。「大阪の現場から」）。日本が正面の地球儀が、大阪を軸に左右へゆっくり振れ、大阪にだけ脈打つ輪が広がる。
 * 弧は出さない（販売先は大阪府内で、どこへ弧を伸ばしても事実に反する）。装飾なので canvas は aria-hidden。
 * Mobile・reduced-motion・WebGL なし・JS なしは静止画（日本が正面の図）のまま。
 */
export interface GlobeOsakaProps {
  /** MotionPause の名前（動いている間）。文言は site-content の MOTION_PAUSE */
  pauseLabel: string;
  /** MotionPause の名前（止まっている間） */
  resumeLabel: string;
  /** 一時停止のボタンの対象名（site-content の MOTION_PAUSE_TARGETS.globe） */
  pauseTarget: string;
  class?: string;
}

/**
 * B（calm）の Reveal。画面に入るとき 16px 下から上がってくる（CSS の scroll-driven animation だけ。JS を読まない）。
 * opacity は触らない（画面の外にある間も文字が 100% の濃さ。axe のコントラスト検査に落ちない）。ヒーローの h1・本文には使わない。
 * 対応していないブラウザ・reduced-motion・印刷では静止。as 以外の属性（aria-labelledby など）はそのまま根の要素に渡す。
 */
export interface RevealProps {
  /** 根の要素。既定 div */
  as?: "div" | "li" | "article" | "section";
  /** 隣り合う要素の遅れの段（0〜3）。step × 80ms 相当だけ、現れ始めを遅らせる */
  step?: 0 | 1 | 2 | 3;
  class?: string;
}

/**
 * B（calm）の数え上げ。最終値を見える文字として HTML に入れ（読み上げはこれだけ）、画面に入ったとき 1 回だけ、aria-hidden の重ねた数字が 0 から最終値まで上がる。
 * 数え上げの時間は --motion-duration-large の 2 倍。JS が無い・遅い・reduced-motion のときは最終値のまま。
 */
export interface CountUpProps {
  /** 最終値の文字（"72.2%"。数字の部分だけが動き、小数の桁と単位を保つ） */
  value: string;
  class?: string;
}

/**
 * A（vivid）の CTA バナーの光の縁と粒（装飾）。CTABanner の slot="decoration" に、MotionBlobs と並べて置く。
 * 一時停止のボタンは CtaGlow が 1 つだけ持ち（storageKey は MotionBlobs と共有の motion:cta-blobs）、光の縁・粒・MotionBlobs の粒をまとめて止める。
 * 動くのは md 以上で、reduced-motion でなく、JS が使えるときだけ（止める手段のボタンが水和して出るまで動き始めない）。
 */
export interface CtaGlowProps {
  /** MotionPause の名前（動いている間）。文言は site-content の MOTION_PAUSE */
  pauseLabel: string;
  /** MotionPause の名前（止まっている間） */
  resumeLabel: string;
  /** 一時停止のボタンの対象名（site-content の MOTION_PAUSE_TARGETS.cta） */
  pauseTarget: string;
  /** 止める対象（CTA バナーの aside）の id。CTABanner の id と同じにする。既定 cta-banner */
  bannerId?: string;
  class?: string;
}

/**
 * ブログ記事の目次の「いまここ」。画面の上の方にある見出しに対応する目次の項目へ aria-current="location" を付け外しする。
 * LegalToc に trackCurrent を渡した目次（[data-toc-track]）が相手。ids は目次の項目の id（見出しの id）。
 */
export interface TocTrackerProps {
  ids: readonly string[];
}
