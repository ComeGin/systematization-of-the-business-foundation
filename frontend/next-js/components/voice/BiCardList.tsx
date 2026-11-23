"use client";

import Badge from "@cloudscape-design/components/badge";
import BarChart from "@cloudscape-design/components/bar-chart";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import LineChart from "@cloudscape-design/components/line-chart";
import type { MixedLineBarChartProps } from "@cloudscape-design/components/mixed-line-bar-chart";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useAgent, useTextStream } from "@livekit/components-react";
import { useMemo, useState } from "react";
import { type BiCard, CARD_TOPIC, type CardColumn, type CellValue, parseCard, toNumber } from "@/lib/livekit/cards";

/** 画面に残すカードの数（古いものから消す） */
const MAX_CARDS = 30;

const CHART_I18N = {
  filterLabel: "系列で絞り込む",
  filterPlaceholder: "系列を選ぶ",
  filterSelectedAriaLabel: "選択中",
  legendAriaLabel: "凡例",
  detailPopoverDismissAriaLabel: "閉じる",
  chartAriaRoleDescription: "グラフ",
  xAxisAriaRoleDescription: "X 軸",
  yAxisAriaRoleDescription: "Y 軸",
} as const;

const numberFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat("ja-JP", { style: "percent", maximumFractionDigits: 1 });
const signedPercentFormat = new Intl.NumberFormat("ja-JP", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" });

type ValueStyle = "number" | "percent" | "signedPercent";

// エージェントは CTR・率を 0〜1 の小数のまま送り、表示の形は画面が決める（visual_output/cards.py）。
// 列の見出しで決める: 「増減率」「変化率」などは符号付きの百分率、それ以外の「率」「CTR」は百分率
function styleOf(column: CardColumn | undefined): ValueStyle {
  const label = column?.label ?? "";
  if (/(増減|変化|伸び|差).*率|change/i.test(label)) return "signedPercent";
  if (/率|CTR|rate/i.test(label)) return "percent";
  return "number";
}

function formatNumber(value: number, style: ValueStyle): string {
  if (style === "percent") return percentFormat.format(value);
  if (style === "signedPercent") return signedPercentFormat.format(value);
  return numberFormat.format(value);
}

function formatCell(value: CellValue, column?: CardColumn): string {
  if (value === null) return "—";
  if (typeof value === "number") return `${formatNumber(value, styleOf(column))}${column?.unit ?? ""}`;
  if (typeof value === "boolean") return value ? "はい" : "いいえ";
  return value;
}

function periodText(card: BiCard): string {
  if (!card.period) return "";
  const base = `${card.period.start} 〜 ${card.period.end}`;
  return card.period.compare ? `${base}（比較: ${card.period.compare.start} 〜 ${card.period.compare.end}）` : base;
}

/**
 * エージェントが送るカード（topic comegin.bi.card）を受けて描く（D4）。
 * 同じ id のカードは新しいもので置き換え、新しい順に並べる。形が契約に合わないものは描かない。
 * 送り手がこのセッションのエージェントのものだけを描く（同じ部屋のほかの参加者が同じ topic で送っても描かない。D4 を画面の側でも守る）。
 * 「開始」し直すと VoiceSession が key を変えて作り直すので、前のセッションのカードは残らない。
 */
export function BiCardList() {
  const { textStreams } = useTextStream(CARD_TOPIC);
  // このセッションのエージェントの identity。終了してエージェントが抜けた後もカードを読めるよう、最後に見えた値を覚えておく
  // （描画中に前の値と比べて更新する React の書き方。key で作り直すまで同じ部品の中だけで持つ）
  const currentAgent = useAgent().identity;
  const [agentIdentity, setAgentIdentity] = useState<string | undefined>(undefined);
  if (currentAgent && currentAgent !== agentIdentity) setAgentIdentity(currentAgent);

  const cards = useMemo(() => {
    const byId = new Map<string, BiCard>();
    if (!agentIdentity) return [];
    for (const stream of textStreams) {
      if (stream.participantInfo.identity !== agentIdentity) continue;
      const card = parseCard(stream.text);
      if (!card) continue; // 受信の途中（JSON が閉じていない）・契約に合わないもの
      byId.delete(card.id); // 置き換えたものを末尾（新しい側）へ
      byId.set(card.id, card);
    }
    return [...byId.values()].reverse().slice(0, MAX_CARDS);
  }, [textStreams, agentIdentity]);

  return (
    <Container header={<Header variant="h2" description="数値はすべて OpenSEO のツールの結果から作られています（結果 ID 付き）。">BI のカード</Header>}>
      {cards.length === 0 ? (
        <Box color="text-status-inactive">まだカードはありません。ブリーフィングや質問の答えに合わせて、ここに表・グラフが出ます。</Box>
      ) : (
        <SpaceBetween size="l">
          {cards.map((card) => (
            <CardView key={card.id} card={card} />
          ))}
        </SpaceBetween>
      )}
    </Container>
  );
}

function CardView({ card }: { card: BiCard }) {
  const meta = [periodText(card), card.source_tool, card.result_id].filter(Boolean).join("・");
  return (
    <SpaceBetween size="s">
      <Header
        variant="h3"
        description={meta}
        info={card.truncated ? <Badge color="grey">上位の行だけ表示</Badge> : undefined}
      >
        {card.title}
      </Header>
      <CardBody card={card} />
    </SpaceBetween>
  );
}

function CardBody({ card }: { card: BiCard }) {
  switch (card.kind) {
    case "kpi":
      return <KpiView card={card} />;
    case "line":
      return <ChartView card={card} kind="line" />;
    case "bar":
      return <ChartView card={card} kind="bar" />;
    default:
      // table と、知らない kind は表として描く
      return <TableView card={card} />;
  }
}

/** kpi: 1 行が 1 つの指標。列は [指標, 今期, 前期?, 増減率?, …]。3 列目以降は見出しを付けて添える */
function KpiView({ card }: { card: BiCard }) {
  const { columns, rows } = card.data;
  if (rows.length === 0) return <Box color="text-status-inactive">値がありません。</Box>;
  return (
    <KeyValuePairs
      columns={Math.min(4, Math.max(1, rows.length))}
      ariaLabel={card.title}
      items={rows.map((row, i) => {
        const [label, value, ...rest] = row;
        const rowLabel = formatCell(label ?? `指標 ${i + 1}`);
        // 今期・前期の値の形は指標の名前（CTR など）で、増減率の形は列の見出しで決める
        const forRow = (column: CardColumn | undefined): CardColumn | undefined =>
          styleOf(column) === "number" ? { key: column?.key ?? "", label: rowLabel, unit: column?.unit } : column;
        const extras = rest
          .map((cell, j) => (cell === null || cell === undefined ? null : `${columns[j + 2]?.label ?? ""} ${formatCell(cell, forRow(columns[j + 2]))}`.trim()))
          .filter((text): text is string => Boolean(text));
        return {
          label: rowLabel,
          value: (
            <SpaceBetween size="xxxs">
              <Box variant="awsui-value-large">{formatCell(value ?? null, forRow(columns[1]))}</Box>
              {extras.length > 0 ? <Box variant="small">{extras.join("・")}</Box> : null}
            </SpaceBetween>
          ),
        };
      })}
    />
  );
}

/**
 * line: 1 列目が横軸（"YYYY-MM-DD" か GA4 の yearWeek〈例 "202646"〉）、2 列目以降が系列。
 * bar: 1 列目が分類（ページの URL など）、2 列目以降が系列。
 * 数値の系列が無ければ表に倒す。
 */
function ChartView({ card, kind }: { card: BiCard; kind: "line" | "bar" }) {
  const { columns, rows } = card.data;
  const xs = rows.map((row) => formatCell(row[0] ?? null));
  const series = columns
    .slice(1)
    .map((column, j) => {
      const data = rows.flatMap((row, i) => {
        const y = toNumber(row[j + 1] ?? null);
        return y === null ? [] : [{ x: xs[i], y }];
      });
      const style = styleOf(column);
      return { title: column.unit ? `${column.label}（${column.unit}）` : column.label, data, style, valueFormatter: (v: number) => formatNumber(v, style) };
    })
    .filter((s) => s.data.length > 0);

  if (rows.length === 0 || series.length === 0) return <TableView card={card} />;

  // 系列がすべて率なら、縦軸の目盛りも % にする
  const sharedStyle = series.every((s) => s.style === series[0].style) ? series[0].style : "number";
  // 分類の名前（URL など）が長い棒は横向きにし、行数に合わせて高さを取る
  const horizontal = kind === "bar" && xs.some((x) => x.length > 12);

  const common = {
    xScaleType: "categorical" as const,
    xTitle: columns[0]?.label,
    yTickFormatter: (v: number) => formatNumber(v, sharedStyle),
    height: horizontal ? Math.min(600, Math.max(240, rows.length * 28)) : 240,
    hideFilter: true,
    ariaLabel: card.title,
    i18nStrings: CHART_I18N,
    empty: <Box color="text-status-inactive">データがありません</Box>,
  };
  return (
    <SpaceBetween size="s">
      {kind === "line" ? (
        <LineChart
          {...common}
          series={series.map(({ title, data, valueFormatter }): MixedLineBarChartProps.LineDataSeries<string> => ({ type: "line", title, data, valueFormatter }))}
        />
      ) : (
        <BarChart
          {...common}
          horizontalBars={horizontal}
          series={series.map(({ title, data, valueFormatter }): MixedLineBarChartProps.BarDataSeries<string> => ({ type: "bar", title, data, valueFormatter }))}
        />
      )}
      <ExpandableSection headerText="表で見る">
        <TableView card={card} />
      </ExpandableSection>
    </SpaceBetween>
  );
}

function TableView({ card }: { card: BiCard }) {
  const { columns, rows } = card.data;
  // 見出しより長い行があっても落とさない
  const width = Math.max(columns.length, ...rows.map((row) => row.length));
  const definitions = Array.from({ length: width }, (_, j) => ({
    id: `c${j}`,
    header: columns[j] ? (columns[j].unit ? `${columns[j].label}（${columns[j].unit}）` : columns[j].label) : `列 ${j + 1}`,
    cell: (row: CellValue[]) => formatCell(row[j] ?? null, columns[j]),
  }));
  return (
    <Table
      variant="embedded"
      columnDefinitions={definitions}
      items={rows}
      empty={<Box color="text-status-inactive">行がありません</Box>}
      ariaLabels={{ tableLabel: card.title }}
      wrapLines
    />
  );
}
