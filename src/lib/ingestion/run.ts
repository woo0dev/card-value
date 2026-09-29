import * as os from "node:os";
import * as path from "node:path";
import { readAndProcessCsvs } from "./pipeline";
import {
  buildCardRow,
  buildPerformanceTierRows,
  buildPerkRows,
  buildRawBenefitSnapshotRow,
  buildRawCardSnapshotRow,
  buildSpendingBenefitRows,
} from "./mapper";
import { writeIngestionResult, type CardWriteBatch } from "./write";

export interface IngestionOptions {
  readonly dryRun: boolean;
  readonly cardsCsvPath?: string;
  readonly benefitsCsvPath?: string;
  /** 주어지면 이 cardAdId 하나만 처리한다(통합 테스트용 — 전체 443개를 다시 돌리지 않음). */
  readonly cardAdId?: string;
}

export interface IngestionReport {
  readonly dryRun: boolean;
  readonly rawCards: number;
  readonly rawBenefits: number;
  readonly toDomainSuccess: number;
  readonly toDomainFailed: number;
  readonly validationSuccess: number;
  readonly validationFailed: number;
  readonly cardsToInsert: number;
  readonly spendingBenefits: number;
  readonly perks: number;
  readonly performanceTiers: number;
  readonly rawCardSnapshots: number;
  readonly rawBenefitSnapshots: number;
}

const DEFAULT_CARDS_CSV_PATH = path.join(os.homedir(), "Downloads", "card_value_cards.csv");
const DEFAULT_BENEFITS_CSV_PATH = path.join(os.homedir(), "Downloads", "card_value_benefits.csv");

/**
 * CSV -> parse -> normalize -> toDomainCard -> validate -> (dry-run이면 보고만 / 아니면 DB
 * 적재)까지의 전체 진입점. `--dry-run`일 때는 `write.ts`(따라서 `supabaseClient.ts`/`env.ts`)를
 * 전혀 호출하지 않으므로 Supabase 환경변수가 없어도 실행된다.
 */
export async function runIngestion(options: IngestionOptions): Promise<IngestionReport> {
  const cardsCsvPath =
    options.cardsCsvPath ?? process.env.CARD_VALUE_CARDS_CSV_PATH ?? DEFAULT_CARDS_CSV_PATH;
  const benefitsCsvPath =
    options.benefitsCsvPath ?? process.env.CARD_VALUE_BENEFITS_CSV_PATH ?? DEFAULT_BENEFITS_CSV_PATH;

  const pipeline = readAndProcessCsvs(cardsCsvPath, benefitsCsvPath, { cardAdId: options.cardAdId });
  // 하나의 ingestion 실행은 하나의 ingestedAt만 쓴다(raw snapshot 두 테이블 전부 동일 시각).
  const ingestedAt = new Date().toISOString();

  const rawCardSnapshotRows = pipeline.rawCards.map((rawCard) => buildRawCardSnapshotRow(rawCard, ingestedAt));
  const rawBenefitSnapshotRows = pipeline.rawBenefits.map((rawBenefit) =>
    buildRawBenefitSnapshotRow(rawBenefit, ingestedAt),
  );

  const cardBatches: CardWriteBatch[] = pipeline.successes.map(({ rawCard, normalized, card }) => ({
    cardRow: buildCardRow(card, rawCard, ingestedAt),
    tierRows: buildPerformanceTierRows(card),
    spendingBenefitRows: buildSpendingBenefitRows(normalized, card),
    perkRows: buildPerkRows(normalized, card),
  }));

  const report: IngestionReport = {
    dryRun: options.dryRun,
    rawCards: pipeline.rawCards.length,
    rawBenefits: pipeline.rawBenefits.length,
    toDomainSuccess: pipeline.successes.length + pipeline.validationFailures.length,
    toDomainFailed: pipeline.toDomainFailures.length,
    validationSuccess: pipeline.successes.length,
    validationFailed: pipeline.validationFailures.length,
    cardsToInsert: cardBatches.length,
    spendingBenefits: cardBatches.reduce((sum, batch) => sum + batch.spendingBenefitRows.length, 0),
    perks: cardBatches.reduce((sum, batch) => sum + batch.perkRows.length, 0),
    performanceTiers: cardBatches.reduce((sum, batch) => sum + batch.tierRows.length, 0),
    rawCardSnapshots: rawCardSnapshotRows.length,
    rawBenefitSnapshots: rawBenefitSnapshotRows.length,
  };

  if (options.dryRun) {
    return report;
  }

  await writeIngestionResult({ rawCardSnapshotRows, rawBenefitSnapshotRows, cardBatches });
  return report;
}
