// サイトで使う写真の一覧（2026-10-14 にユーザーが用意した画像アセットから選んだもの）。
// 置き場は assets/（長辺 2000px の WebP に縮小済み）。原本の PNG は frontend/verdant-virgo/assets-original/ にあり、追跡しない。
// 配信するサイズ（srcset）は Photo 部品が Astro の <Image> でビルド時に作る。public/ には置かない（原本のまま配信されるため）。
// alt は写っているものを書く（説明の文は本文が持つ）。人物の写真に、実在の事業所や利用者だと読める説明を付けない。

import type { ImageMetadata } from "astro";
import careHands from "../assets/care-hands.webp";
import careRecreation from "../assets/care-recreation.webp";
import educationChildren from "../assets/education-children.webp";
import memberKamegin from "../assets/member-kamegin.webp";
import techSmartglasses from "../assets/tech-smartglasses.webp";
import techSmartwatch from "../assets/tech-smartwatch.webp";
import techVr from "../assets/tech-vr.webp";
import welfareWorkSupport from "../assets/welfare-work-support.webp";
import workOfficeWheelchair from "../assets/work-office-wheelchair.webp";
import workRemoteWheelchair from "../assets/work-remote-wheelchair.webp";

export interface PhotoAsset {
  readonly src: ImageMetadata;
  readonly alt: string;
  /** object-position（切り抜いたときに残す位置）。既定は中央 */
  readonly focus?: string;
}

export const PHOTOS = {
  /** トップ 1-3 ヒーロー（元: DisabilityWelfare/就労支援2.png） */
  workOfficeWheelchair: {
    src: workOfficeWheelchair,
    alt: "車いすの男性が、オフィスの机でノートパソコンに向かい、同僚と話している",
  },
  /** 会社概要 5-3 ヒーロー（元: DisabilityWelfare/フリーライター.png） */
  workRemoteWheelchair: {
    src: workRemoteWheelchair,
    alt: "車いすの女性が、明るい部屋の机でノートパソコンを使って仕事をしている",
  },
  /** 業務提携の対象（障がい福祉）（元: DisabilityWelfare/就労支援.png） */
  welfareWorkSupport: {
    src: welfareWorkSupport,
    alt: "支援者が、ノートパソコンに向かう女性に画面を指さして説明している",
  },
  /** 業務提携の対象（教育）（元: DisabilityWelfare/児童デイ.png） */
  educationChildren: {
    src: educationChildren,
    alt: "机を囲んで、大人と子どもたちが一緒に勉強している",
  },
  /** 業務提携の対象（介護）（元: NursingCare/レクリエーション.png） */
  careRecreation: {
    src: careRecreation,
    alt: "介護施設の明るい談話室で、職員と高齢の方がテーブルを囲んでレクリエーションをしている",
  },
  /** 業務提携の詳細ヒーロー（元: NursingCare/手を添える.png） */
  careHands: {
    src: careHands,
    alt: "介護職員が、車いすの方の手にそっと手を添えている",
  },
  /** 会社概要 5-7 メンバー・ブログ記事 8-7 著者（元: コーポレートポーズ.png） */
  memberKamegin: {
    src: memberKamegin,
    alt: "亀谷 銀大の写真",
    focus: "50% 20%",
  },
  /** 環境構築の詳細ヒーロー（元: スマートウォッチ.png） */
  techSmartwatch: {
    src: techSmartwatch,
    alt: "手首のスマートウォッチを操作する手と、その周りに浮かぶ数値のグラフ",
  },
  /** 受託開発の詳細ヒーロー（元: スマートグラス.png） */
  techSmartglasses: {
    src: techSmartglasses,
    alt: "スマートグラスをかけた人の目元と、重なって表示される情報の図",
  },
  /** コンサルの詳細ヒーロー（元: VRゴーグル.png） */
  techVr: {
    src: techVr,
    alt: "VR ゴーグルを着けた人が、目の前に浮かぶデジタルの画面に手を伸ばしている",
  },
} as const satisfies Record<string, PhotoAsset>;

export type PhotoKey = keyof typeof PHOTOS;
