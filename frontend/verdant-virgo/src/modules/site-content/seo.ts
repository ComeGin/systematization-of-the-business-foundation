// 画面ごとの SEO メタ情報。01-content-spec.md §7 の表を一字一句写す（表の `\|` は半角の「|」）。
// og:title / og:description は title・description と同じ（§7.1）。
// description が「（設定しない）」の画面は description を持たない。

export interface PageSeo {
  readonly title: string;
  readonly description?: string;
  readonly noindex: boolean;
  /** og:type（§7.1。ブログ記事だけ article） */
  readonly ogType: 'website' | 'article';
}

const page = (title: string, description: string | undefined, noindex = false): PageSeo => ({
  title,
  description,
  noindex,
  ogType: 'website',
});

export const SEO = {
  top: page(
    '社内に IT 人材がいなくても業務を変える | ComeGin',
    'ComeGin は、社内に IT 担当がいない企業の業務を、IT 人材を 1人雇うより低い予算で変えます。現場に伺って業務を棚卸しし、要件定義から運用保守まで一人で責任を負います。自社で開発したシステムのソースコードは無料で公開しています。',
  ),
  services: page(
    'サービス一覧｜環境構築・受託開発・コンサル | ComeGin',
    'ComeGin のサービス一覧です。事業経営基盤の環境構築、バイブコーディングから要件定義〜運用保守までの受託開発、1回 4時間のコンサル、福祉・介護・教育の事業者さまとの業務提携の 4 つをご用意しています。料金と期間の目安も掲載しています。',
  ),
  serviceDevelopment: page(
    '受託開発｜バイブコーディングから運用保守まで | ComeGin',
    'ComeGin の受託開発は、7日間のバイブコーディングのみのプランと、要件定義から運用保守までを定期常駐で 60〜90日かけて進めるプランの 2 つです。対象となるお客さま、進め方、料金（税別）、よくある質問をまとめています。',
  ),
  serviceEnvironmentSetup: page(
    '環境構築｜事業経営基盤を 1日で立ち上げ | ComeGin',
    'ComeGin の環境構築は、事業経営基盤一式をお客さまのクラウドまたは端末に 1日で構築するサービスです。23,000円（税別）。ソースコードは無料で配布しているため、ご自身で構築することもできます。クラウドの利用料はお客さまのご負担です。',
  ),
  serviceConsulting: page(
    'コンサル｜DX を小さく作って確かめながら進める | ComeGin',
    'ComeGin のコンサルは、DX の推進を、バイブコーディングで小さく作って確かめながら進める伴走支援です。業務の棚卸し、優先順位づけ、試作と検証、社内への定着までをご一緒します。31,250円／回・4時間／回で、4回からお申し込みいただけます。表示価格はすべて税別です。',
  ),
  servicePartnership: page(
    '業務提携｜福祉・介護・教育の事業者さまと | ComeGin',
    'ComeGin の業務提携は、福祉・介護・教育事業を行う中小企業、社会福祉法人、非営利団体の皆さまとご一緒します。開発の費用はレベニューシェアで回収する計画を個別に決めます。契約期間は 1年で自動更新です。',
  ),
  pricing: page(
    '料金｜環境構築・受託開発・コンサルの価格 | ComeGin',
    'ComeGin の料金ページです。環境構築 23,000円、受託開発 50,000円から、コンサル 31,250円／回など、全サービスの金額と期間を一覧で掲載しています。表示価格はすべて税別です。業務提携は要相談です。',
  ),
  about: page(
    '会社概要｜働く者に等しく賃金が渡る社会へ | ComeGin',
    'ComeGin は代表 1名の個人事業です。社内に IT 人材がいなくても、1人分の予算で業務を変えることを仕事にしています。目指すのは、障がいの有無にかかわらず、働く者に等しく賃金が渡る社会です。大切にしていること、経歴、会社情報を掲載しています。',
  ),
  contact: page(
    '無料相談・お問い合わせ｜事業経営基盤の構築 | ComeGin',
    '事業経営基盤の構築、受託開発、コンサル、業務提携についての無料相談フォームです。会社名・氏名・メールアドレス・相談内容をご入力ください。内容を確認のうえ、担当者からメールでご連絡します。チャットでのご質問も受け付けています。',
  ),
  contactThanks: page('ご相談を受け付けました | ComeGin', undefined, true),
  blog: page(
    'ブログ｜現場の困りごとと、その直し方 | ComeGin',
    'ComeGin のブログです。情報セキュリティなど IT の困りごとを相談する先が「特にない」中小企業は、50.8% です（IPA、2025年）。現場の困りごとと、その直し方を、課題の整理、手法の比較、導入の進め方の 3つの段階でお届けします。',
  ),
  notFound: page('ページが見つかりません | ComeGin', undefined, true),
  privacy: page(
    'プライバシーポリシー | ComeGin',
    'ComeGin のプライバシーポリシーです。お問い合わせフォームや資料のダウンロードで取得する個人情報の利用目的、アクセス解析や行動分析ツールによる外部送信、国外の事業者への提供、開示等のご請求の窓口について定めています。',
  ),
  tokushoho: page(
    '特定商取引法に基づく表記 | ComeGin',
    'ComeGin の特定商取引法に基づく表記です。事業者の名称、所在地、連絡先、販売価格、商品代金以外に必要な料金、お支払い方法と時期、役務の提供時期、キャンセルについての条件を掲載しています。表示価格はすべて税別です。',
  ),
} as const satisfies Record<string, PageSeo>;

export type PageSeoKey = keyof typeof SEO;

/**
 * ブログ記事の SEO（§7 の「ブログ記事」の行）。title は `{記事タイトル} | ComeGin`、
 * description は Strapi の要約欄（article.description）。
 */
export function articleSeo(articleTitle: string, summary: string): PageSeo {
  return { title: `${articleTitle} | ComeGin`, description: summary, noindex: false, ogType: 'article' };
}


/**
 * ブログ一覧のページ送り（/blog の 2 ページ目以降）の SEO（リードの決定。§7 に行が無いため）。
 * 1 ページ目は §7 のブログ一覧の値そのまま。2 ページ目以降は title のページ名だけ「ブログ（Nページ目）」にし、
 * 区切り（｜）と末尾（ | ComeGin）、description は 1 ページ目と同じ。noindex にはしない（canonical はページ自身）。
 */
export function blogIndexSeo(page: number): PageSeo {
  if (page <= 1) return SEO.blog;
  return { ...SEO.blog, title: SEO.blog.title.replace(/^ブログ/, `ブログ（${page}ページ目）`) };
}

/**
 * ブログのカテゴリ別の一覧の SEO（リードの決定。§7 に行が無いため）。
 * title はブログ一覧の書式のまま、ページ名の後ろに「（<カテゴリ名>）」、2 ページ目以降は「（<カテゴリ名>・Nページ目）」を付ける。
 * description はブログ一覧と同じ。noindex にはしない。
 */
export function blogCategorySeo(label: string, page: number): PageSeo {
  const suffix = page <= 1 ? label : `${label}・${page}ページ目`;
  return { ...SEO.blog, title: SEO.blog.title.replace(/^ブログ/, `ブログ（${suffix}）`) };
}
