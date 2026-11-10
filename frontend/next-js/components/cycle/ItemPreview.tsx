"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { CycleItemPreview } from "control-plane";
import { Markdown } from "@/components/common/Markdown";

const PR_STATE_LABEL = { open: "開いている（承認待ち）", approved: "承認済み", merged: "マージ済み", closed: "閉じられた" } as const;

function List({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span>{empty}</span>;
  return (
    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
      {items.map((item, index) => (
        <li key={`${index}-${item}`} style={{ overflowWrap: "anywhere" }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function Cover({ url, pendingFileId }: { url: string | null; pendingFileId: number | null | undefined }) {
  return (
    <SpaceBetween size="xxs">
      {url ? (
        // 本番の Strapi のメディア（下書きの表紙）。next/image のドメイン設定は持たないため、そのまま出す
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="アイキャッチ画像（確認用）" style={{ maxWidth: "100%", maxHeight: 240, objectFit: "contain" }} />
      ) : (
        <span>なし</span>
      )}
      {pendingFileId != null ? (
        <Box variant="small" color="text-status-warning">
          アップロード済みで、まだ記事の表紙に結べていない画像がある（ファイル ID {pendingFileId}）。OK の後の手順で結ぶ
        </Box>
      ) : null}
    </SpaceBetween>
  );
}

function TextBox({ children }: { children: string }) {
  return (
    <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", border: "1px solid rgba(128,128,128,0.45)", borderRadius: 4, padding: 8 }}>
      {children}
    </div>
  );
}

/** セグメントの件数。-1 は「件数を読めなかった」（送り先の個人情報は、件数とセグメント名のほかは出さない） */
function segmentCountText(count: number): string {
  return count < 0 ? "件数を読めなかった" : `${count} 件`;
}

/** 項目の中身の確認用の表示。種類ごとに違う。 */
export function ItemPreview({ preview }: { preview: CycleItemPreview }) {
  switch (preview.kind) {
    case "pending":
      return <StatusIndicator type="loading">作成中（中身はまだ無い）</StatusIndicator>;

    case "article":
      return (
        <SpaceBetween size="m">
          <KeyValuePairs
            columns={2}
            items={[
              { label: "タイトル", value: preview.titleText },
              { label: "slug", value: <Box variant="code">{preview.slug}</Box> },
              { label: `description（${[...preview.description].length} 文字）`, value: preview.description || "なし" },
              { label: "アイキャッチ画像", value: <Cover url={preview.coverUrl} pendingFileId={preview.coverPendingFileId} /> },
            ]}
          />
          <ExpandableSection headerText="本文" defaultExpanded>
            <Markdown>{preview.bodyMarkdown}</Markdown>
          </ExpandableSection>
        </SpaceBetween>
      );

    case "campaign":
      return (
        <SpaceBetween size="m">
          <KeyValuePairs
            columns={2}
            items={[
              { label: "メールのリンク先", value: <span style={{ overflowWrap: "anywhere" }}>{preview.linkUrl}</span> },
              { label: "送信先のセグメント", value: `${preview.segmentName}（${segmentCountText(preview.segmentCount)}）` },
              { label: "件名", value: preview.emailSubject },
              {
                label: "配布ファイル",
                value: (
                  <List
                    items={preview.assets.map((asset) => `${asset.name}（${asset.url ?? "記事にまだ結ばれていない"}）`)}
                    empty="なし"
                  />
                ),
              },
            ]}
          />
          {preview.coverPendingFileId != null ? (
            <Box variant="small" color="text-status-warning">
              キャンペーンの記事の表紙に結べていない画像がある（ファイル ID {preview.coverPendingFileId}）。OK の後の手順で結ぶ
            </Box>
          ) : null}
          <ExpandableSection headerText="メールの本文" defaultExpanded>
            <TextBox>{preview.emailBody}</TextBox>
          </ExpandableSection>
        </SpaceBetween>
      );

    case "code":
      return (
        <SpaceBetween size="m">
          <KeyValuePairs
            columns={2}
            items={[
              { label: "改修案", value: preview.proposalId },
              { label: "変更したファイル", value: <List items={preview.files} empty="なし" /> },
            ]}
          />
          <ExpandableSection headerText="差分の要約" defaultExpanded>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{preview.diffStat}</pre>
          </ExpandableSection>
        </SpaceBetween>
      );

    case "deploy": {
      const { lighthouse } = preview;
      return (
        <SpaceBetween size="m">
          {preview.blocked ? (
            <Alert type="error" header="この配信は OK を出せない">
              {preview.blocked}
            </Alert>
          ) : null}
          <KeyValuePairs
            columns={3}
            items={[
              { label: "コミット", value: <Box variant="code">{preview.commitSha}</Box> },
              { label: "dist の置き場", value: <span style={{ overflowWrap: "anywhere" }}>{preview.distPath}</span> },
              {
                label: "Lighthouse（0〜1）",
                value: `性能 ${lighthouse.performance}・a11y ${lighthouse.accessibility}・ベストプラクティス ${lighthouse.bestPractices}・SEO ${lighthouse.seo}`,
              },
            ]}
          />
          <Box>
            <Box variant="awsui-key-label">含まれる変更</Box>
            <List items={preview.changes} empty="なし" />
          </Box>
        </SpaceBetween>
      );
    }

    case "proposal":
      return (
        <SpaceBetween size="xxs">
          <KeyValuePairs
            columns={3}
            items={[
              { label: "PR", value: preview.prNumber === null ? "まだ作られていない（daily-i13-file が起票する）" : `#${preview.prNumber}` },
              {
                label: "PR のリンク",
                value: preview.prUrl ? (
                  <Link href={preview.prUrl} external target="_blank" rel="noopener noreferrer" externalIconAriaLabel="（新しいタブで開く）">
                    GitHub で PR を開く
                  </Link>
                ) : (
                  "-"
                ),
              },
              { label: "PR の状態", value: preview.prState ? PR_STATE_LABEL[preview.prState] : "-" },
            ]}
          />
          <Box variant="small" color="text-body-secondary">
            OK はここでは押さない。GitHub で PR を承認してマージすると、次の段階に進む。
          </Box>
        </SpaceBetween>
      );

    case "manual":
      return <span style={{ whiteSpace: "pre-wrap" }}>{preview.description}</span>;
  }
}
