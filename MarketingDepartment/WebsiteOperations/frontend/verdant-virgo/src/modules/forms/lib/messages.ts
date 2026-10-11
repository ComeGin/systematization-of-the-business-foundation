// フォームの文言。01-content-spec.md §5.1・§5.2 から一字一句写す。

export const VALIDATION = {
  companyRequired: '会社名を入力してください',
  companyTooLong: '会社名は 100文字以内で入力してください',
  lastnameRequired: '姓を入力してください',
  firstnameRequired: '名を入力してください',
  nameTooLong: '姓・名はそれぞれ 50文字以内で入力してください',
  emailRequired: 'メールアドレスを入力してください',
  emailInvalid: 'メールアドレスの形式が正しくありません（例: name@example.com）',
  messageRequired: 'ご相談内容を入力してください',
  messageTooLong: 'ご相談内容は 2,000文字以内で入力してください',
  privacyRequired: 'プライバシーポリシーへの同意が必要です',
} as const;

export const CONSULT_TEXT = {
  companyLabel: '会社名',
  employeeLabel: '従業員数',
  employeePlaceholder: '選択してください',
  employeeOptions: [
    { value: '1-5', label: '1〜5人' },
    { value: '6-20', label: '6〜20人' },
    { value: '21-50', label: '21〜50人' },
    { value: '51-100', label: '51〜100人' },
    { value: '101+', label: '101人以上' },
  ],
  itDepartmentLabel: '社内の IT の担当部署',
  itDepartmentOptions: [
    { value: 'yes', label: 'ある' },
    { value: 'no', label: 'ない' },
    { value: 'unknown', label: 'わからない' },
  ],
  nameLabel: '氏名',
  lastnamePlaceholder: '姓',
  firstnamePlaceholder: '名',
  emailLabel: 'メールアドレス',
  emailPlaceholder: 'name@example.com',
  emailHelper: 'ご連絡はこのメールアドレスにお送りします。',
  messageLabel: 'ご相談内容',
  messagePlaceholder: 'ご検討中のサービスや、いまお困りのことを自由にお書きください。',
  submit: '無料相談を申し込む',
  submitting: '送信中…',
  noteBelowButton:
    '送信後の画面で、オンライン面談の日時をお選びいただけます。日程が決まらない場合も、通常 3営業日以内に担当者からメールでご連絡します。',
  errorSummary: '入力内容に誤りがあります。赤字の項目をご確認ください。',
  failedTitle: '送信できませんでした',
  timeoutTitle: '応答がありませんでした',
  failedBody:
    '一時的な障害の可能性があります。入力内容はそのまま残っています。時間をおいて、もう一度「無料相談を申し込む」を押してください。解決しない場合は kamegin4@comegin.com までメールでご連絡ください。',
  duplicateBody:
    'このブラウザから本日すでに送信いただいています。追加でお伝えしたいことは、担当者からのメールにご返信ください。',
} as const;

export const SOURCE_DL_TEXT = {
  emailLabel: 'メールアドレス',
  emailPlaceholder: 'name@example.com',
  optinLabel: 'ComeGin からのお知らせメールを受け取る（いつでも配信を停止できます）',
  submit: '構築の手順書を受け取る',
  submitting: '送信中…',
  noteBelowButton: 'メールアドレスだけで受け取れます。構築の手順書を、メールでお送りします。',
  failedTitle: '登録できませんでした',
  failedBody: '一時的な障害の可能性があります。時間をおいて、もう一度お試しください。',
  successTitle: 'ご登録ありがとうございます',
  successBody:
    '構築の手順書を、ご入力のメールアドレスにお送りしました。ソースコードの公開先も、手順書の中でご案内しています。数分たっても届かない場合は、迷惑メールフォルダをご確認ください。',
  repositoryLink: 'ソースコードを見る（GitHub）',
} as const;

/** 同意のチェックボックスのラベル（「プライバシーポリシー」は /legal/privacy へのリンク。新しいタブ） */
export const PRIVACY_CONSENT = {
  linkText: 'プライバシーポリシー',
  rest: 'に同意する',
  href: '/legal/privacy',
} as const;

export const BADGE = { required: '必須', optional: '任意' } as const;
