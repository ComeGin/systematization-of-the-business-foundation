"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { SetupGuide, SetupStatusItemView, SetupStatusStepView, SetupStopGuide } from "control-plane";
import { useState } from "react";
import { Markdown } from "@/components/common/Markdown";
import { formatTime } from "@/components/common/navigation";
import { DocSection } from "./DocSection";
import { LevelStatus } from "./LevelStatus";
import { CommandText } from "./RunOrderPanel";
import { isCheckCommand } from "./status-format";

/** 項目の見出しの横に出すもの: 状態・だれが・止まる id・確かめた時刻 */
function ItemMeta({ item }: { item: SetupStatusItemView }) {
  return (
    <SpaceBetween direction="horizontal" size="xs">
      <LevelStatus level={item.level} />
      <Box color="text-body-secondary">{item.who}</Box>
      {item.stopId ? <Box variant="code">{item.stopId}</Box> : null}
      {item.checkedAt ? <Box color="text-body-secondary">確かめた時刻 {formatTime(item.checkedAt, "minute")}</Box> : null}
    </SpaceBetween>
  );
}

/** 止まったときの案内（setup/manual-steps.md の早見表の 1 行） */
function StopGuideBox({ stopId, guide }: { stopId: string; guide: SetupStopGuide }) {
  return (
    <Container
      variant="stacked"
      header={
        <Header variant="h3" description="setup/manual-steps.md の 0 節（早見表）。操作が終わったら、同じコマンドを実行し直す">
          止まったとき（<Box variant="code">{stopId}</Box>）
        </Header>
      }
    >
      <KeyValuePairs
        columns={3}
        items={[
          { label: "いつ止まるか", value: <Markdown>{guide.when}</Markdown> },
          { label: "何をするか", value: <Markdown>{guide.what}</Markdown> },
          { label: "節（下の手順書）", value: <Markdown>{guide.section}</Markdown> },
        ]}
      />
    </Container>
  );
}

/** 項目 1 件。開いたときに、止まったときの案内と、正本の節の本文（その場で読む）を出す。 */
function ItemCard({ item, stopGuide }: { item: SetupStatusItemView; stopGuide: SetupStopGuide | null }) {
  // 「更新が必要」で止まる id の案内があるものは、最初から開いておく（何をすればよいかを先に見せる）
  const [expanded, setExpanded] = useState(item.level === "action" && stopGuide !== null);

  if (item.docs.length === 0 && stopGuide === null) {
    return (
      <Container header={<Header variant="h3" info={<ItemMeta item={item} />} description={item.evidence}>{item.title}</Header>} />
    );
  }
  return (
    <ExpandableSection
      variant="container"
      headerText={item.title}
      headerInfo={<ItemMeta item={item} />}
      headerDescription={item.evidence}
      expanded={expanded}
      onChange={({ detail }) => setExpanded(detail.expanded)}
    >
      {/* 開いたときだけ読む（閉じている項目のために API を呼ばない） */}
      {expanded ? (
        <SpaceBetween size="m">
          {stopGuide && item.stopId ? <StopGuideBox stopId={item.stopId} guide={stopGuide} /> : null}
          {item.docs.map((doc) => (
            <DocSection key={`${doc.file}#${doc.heading}`} file={doc.file} heading={doc.heading} />
          ))}
        </SpaceBetween>
      ) : null}
    </ExpandableSection>
  );
}

/** 段階のコマンドと、止まったときの操作（setup/README.md の終了コードと 00-setup-overview.md の「設定スクリプトの基本の動き」） */
function StepCommands({ commands, stopTableError }: { commands: string[]; stopTableError: string | null }) {
  const runCommands = commands.filter((command) => !isCheckCommand(command));
  return (
    <Container header={<Header variant="h3">コマンドと止まったとき</Header>}>
      <SpaceBetween size="m">
        {commands.length === 0 ? (
          <Box variant="p">
            この段階は設定スクリプトでは進めません（人が行う手順）。下の項目を開き、正本の手順書の順に行ってください。
          </Box>
        ) : (
          <>
            <SpaceBetween size="xs">
              <Box variant="awsui-key-label">この段階を進める（やり直す）コマンド。リポジトリのルートで実行する</Box>
              {commands.map((command) => (
                <SpaceBetween key={command} direction="horizontal" size="xs" alignItems="center">
                  <CommandText command={command} />
                  {isCheckCommand(command) ? <Box color="text-body-secondary">確かめるだけ</Box> : null}
                </SpaceBetween>
              ))}
            </SpaceBetween>
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: "「画面での操作が必要: …（id）」と出て止まった（終了コード 3）",
                  value: (
                    <Box variant="p">
                      表示された手順を行い、<b>同じコマンドを実行し直す</b>。済んだ手順は飛ばして続きから進む。id ごとの操作は、下の項目の「止まったとき」（setup/manual-steps.md の早見表）にある。
                    </Box>
                  ),
                },
                {
                  label: "失敗して止まった（終了コード 1）",
                  value: (
                    <Box variant="p">
                      表示された理由を直してから、表示された「続きから実行する」のコマンド（
                      <Box variant="code">{`${runCommands[0] ?? commands[0]} --from <モジュールの id>`}</Box>
                      ）を実行する。モジュールの id は <Box variant="code">--list</Box> で見られる。
                    </Box>
                  ),
                },
                {
                  label: "何も変えずに今の状態を見る",
                  value: (
                    <Box variant="p">
                      コマンドの末尾に <Box variant="code">--check</Box> を付ける（AWS と製品には読み取りだけ。状態ファイルにも書かない）。
                    </Box>
                  ),
                },
              ]}
            />
          </>
        )}
        {stopTableError ? (
          <Alert type="warning" header="止まったときの案内を読めませんでした">
            {stopTableError}
          </Alert>
        ) : null}
      </SpaceBetween>
    </Container>
  );
}

/** 右: 選んだ段階のコマンドと止まったときの操作、項目。 */
export function StepDetail({ step, guide }: { step: SetupStatusStepView | null; guide: SetupGuide | null }) {
  if (!step) return <Container header={<Header variant="h2">項目</Header>}>左の一覧から段階を選んでください。</Container>;
  const commands = guide?.stepCommands[step.id];
  return (
    <SpaceBetween size="m">
      <Header variant="h2" counter={`(${step.items.length})`} info={<LevelStatus level={step.level} />}>
        {step.id} {step.title}
      </Header>
      {/* 古いカタログ（commands が無い）では出さない */}
      {guide && commands !== undefined ? <StepCommands commands={commands} stopTableError={guide.stopTableError} /> : null}
      {step.items.length === 0 ? <Box color="text-body-secondary">この段階に項目はありません</Box> : null}
      {step.items.map((item) => (
        <ItemCard key={item.id} item={item} stopGuide={(item.stopId && guide?.stopGuides[item.stopId]) || null} />
      ))}
    </SpaceBetween>
  );
}
