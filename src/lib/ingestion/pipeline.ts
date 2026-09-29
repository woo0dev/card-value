import * as fs from "node:fs";
import type { NormalizedCard } from "../card-data/normalizeTypes";
import { normalizeCard } from "../card-data/normalizeCard";
import { parseBenefitCsv, parseCardCsv } from "../card-data/parseCsv";
import { toDomainCard, type ToDomainCardFailureReason } from "../card-data/toDomainCard";
import type { RawBenefitRecord, RawCardRecord } from "../card-data/types";
import { validateCard } from "../recommendation/validation";
import type { ValidatedCard, ValidationIssue } from "../recommendation/types/validation";

/**
 * CSV → parse → normalize → toDomainCard → validate 흐름을 한 번 실행하고 결과를 분류해
 * 돌려준다. Supabase를 전혀 참조하지 않는다 — dry-run과 실제 적재 양쪽에서 그대로
 * 재사용하기 위한 순수 orchestration이다.
 */

export interface PipelineSuccess {
  readonly rawCard: RawCardRecord;
  readonly normalized: NormalizedCard;
  readonly card: ValidatedCard;
}

export interface PipelineToDomainFailure {
  readonly cardAdId: string;
  readonly reasons: readonly ToDomainCardFailureReason[];
}

export interface PipelineValidationFailure {
  readonly cardAdId: string;
  readonly errors: readonly ValidationIssue[];
}

export interface PipelineResult {
  readonly rawCards: readonly RawCardRecord[];
  readonly rawBenefits: readonly RawBenefitRecord[];
  readonly successes: readonly PipelineSuccess[];
  readonly toDomainFailures: readonly PipelineToDomainFailure[];
  readonly validationFailures: readonly PipelineValidationFailure[];
}

export interface ReadAndProcessCsvsOptions {
  /** 주어지면 이 cardAdId 하나만 처리한다(raw snapshot 대상도 이 카드로 한정됨). 통합
   * 테스트처럼 전체 443개를 다시 돌리지 않고 카드 1개만 검증하고 싶을 때 쓴다. */
  readonly cardAdId?: string;
}

export function readAndProcessCsvs(
  cardsCsvPath: string,
  benefitsCsvPath: string,
  options: ReadAndProcessCsvsOptions = {},
): PipelineResult {
  const cardsCsvText = fs.readFileSync(cardsCsvPath, "utf8");
  const benefitsCsvText = fs.readFileSync(benefitsCsvPath, "utf8");
  const allRawCards = parseCardCsv(cardsCsvText).cards;
  const allRawBenefits = parseBenefitCsv(benefitsCsvText).benefits;
  const rawCards =
    options.cardAdId === undefined ? allRawCards : allRawCards.filter((c) => c.cardAdId === options.cardAdId);
  const rawBenefits =
    options.cardAdId === undefined
      ? allRawBenefits
      : allRawBenefits.filter((b) => b.cardAdId === options.cardAdId);

  const benefitsByCard = new Map<string, RawBenefitRecord[]>();
  for (const benefit of rawBenefits) {
    const existing = benefitsByCard.get(benefit.cardAdId);
    if (existing) existing.push(benefit);
    else benefitsByCard.set(benefit.cardAdId, [benefit]);
  }

  const successes: PipelineSuccess[] = [];
  const toDomainFailures: PipelineToDomainFailure[] = [];
  const validationFailures: PipelineValidationFailure[] = [];

  for (const rawCard of rawCards) {
    const benefits = benefitsByCard.get(rawCard.cardAdId) ?? [];
    const normalized = normalizeCard(rawCard, benefits);
    const result = toDomainCard(normalized);

    if (result.status !== "success") {
      toDomainFailures.push({ cardAdId: rawCard.cardAdId, reasons: result.reasons });
      continue;
    }

    const validation = validateCard(result.card);
    if (!validation.valid) {
      validationFailures.push({ cardAdId: rawCard.cardAdId, errors: validation.errors });
      continue;
    }

    successes.push({ rawCard, normalized, card: validation.value });
  }

  return { rawCards, rawBenefits, successes, toDomainFailures, validationFailures };
}
