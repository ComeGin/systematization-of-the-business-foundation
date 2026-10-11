// 予約枠の文言（01-content-spec.md §4.6 の 6'-2）。見出しと本文はページ（site-content/contact.ts）が props で渡す。

export const BOOKING_TEXT = {
  failedTitle: '予約枠を表示できませんでした',
  failedBody:
    'お手数ですが、担当者からのメールで日程を調整させてください。3営業日以内にご連絡します。お急ぎの場合は kamegin4@comegin.com までご連絡ください。',
  notes: [
    '予約の受付は、米国の事業者が提供する外部の予約サービスで行います。',
    'ご予約が成立すると、面談の予定をお知らせするために、お名前・メールアドレス・日時を Google カレンダーに送ります。',
  ],
  privacyNote: { before: 'くわしくは', linkText: 'プライバシーポリシー', after: 'をご覧ください。', href: '/legal/privacy' },
} as const;
