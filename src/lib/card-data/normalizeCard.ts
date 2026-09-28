import type { RawBenefitRecord, RawCardRecord } from "./types";
import type {
  CardIdentity,
  NormalizationOutcome,
  NormalizationProvenance,
  NormalizationWarning,
  NormalizedBenefit,
  NormalizedBenefitPiece,
  NormalizedCard,
  NormalizedPerformanceTier,
  NormalizedReward,
  NormalizedSpendingBenefitPiece,
  UnsupportedConditionCode,
} from "./normalizeTypes";
import { createBenefitId, createPerformanceTierId } from "./id";
import type { BasisPoints, CategoryTarget, SpendingCategory, Won } from "../recommendation/types";

/**
 * `card_ad_id=1294`(KB국민 굿데이올림카드) 하나를 대상으로 실제로 동작하는 최소
 * normalization pipeline. 443장 전체를 지원하는 것이 목표가 아니다 — 이 카드의 실제
 * benefit 텍스트에서 확인되는, 아래 "지원 범위"에 해당하는 패턴만 처리하고, 그 밖의
 * 모든 것(건당 조건, 횟수 제한, 특정 가맹점, 국내/해외 조합, 신규회원 이벤트, 단위 기반
 * 적립, 복잡한 tiered rate, shared cap 자동 추론 등)은 `unsupported`/`unverified`로
 * 남기며 절대 추측해서 채우지 않는다.
 *
 * `benefit_values_json`은 쓰지 않는다 — 배열 길이가 실적 구간 수와 무관함이 이미
 * 실측으로 확인되었다(예: 구간 2개인데 원소 10개). 실제 조건은 `benefit_descriptions_json`
 * (문단 배열의 배열)과 `benefit_summary`에서만 읽는다.
 */

const CATEGORY_BY_RAW_LABEL: ReadonlyMap<string, SpendingCategory> = new Map([
  ["주유", "fuel"],
  ["통신", "telecom"],
  ["카페/베이커리", "cafe"],
  ["편의점", "convenience_store"],
  ["의료", "medical"],
]);

/**
 * "MERCHANT_SPECIFIC"은 이 목록처럼 특정 브랜드 자체가 혜택의 핵심 대상인 경우에만
 * 쓴다(예: 신한카드 The Best-XO의 "커피전문점: 스타벅스, 커피빈, 투썸플레이스"처럼
 * 업종 전체가 아니라 소수 브랜드로 한정되는 경우). "대형마트: 이마트, 롯데마트,
 * 홈플러스"처럼 그 나열 자체가 사실상 해당 업종 전체를 구성하는 경우는 여기 해당하지
 * 않는다 — 그런 경우는 카테고리 자체가 아니라 "제외 조건"이 문제이므로
 * `AMBIGUOUS_TARGET_CATEGORY`로 다룬다(아래 `detectTarget` 참고). 목록이 작고
 * 보수적인 이유는 무엇을 "특정 브랜드"로 볼지가 결국 업계 지식(경쟁사가 몇 곳인지 등)에
 * 달려 있어서, 명확히 확인된 사례만 넣기 위함이다.
 */
const NAMED_MERCHANT_MARKERS = ["스타벅스", "커피빈", "투썸플레이스", "CGV", "롯데시네마", "메가박스"];

/** `1구간 (30만원 이상~60만원 미만) : 20만원` / `2구간 (60만원 이상) : 40만원` 형태의 한 줄. */
const TIER_CAP_LINE =
  /^(\d+)구간\s*\((\d+)만원\s*이상(?:\s*~\s*\d+만원\s*미만)?\)\s*:\s*(\d+)만원\s*$/;

interface TierCapMatch {
  readonly thresholdWon: number;
  readonly capWon: number;
  readonly line: string;
}

function asWon(value: number): Won {
  return value as Won;
}

function asBasisPoints(value: number): BasisPoints {
  return value as BasisPoints;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** CSV의 숫자 문자열("300000.0" 등)을 원 단위 정수로 바꾼다. 실패하면 `null`. */
function parseWholeNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return isNonNegativeSafeInteger(n) ? n : null;
}

/** `benefit_descriptions_json`은 문단(줄) 배열의 배열이다. 형태가 예상과 다르면 `null`. */
function parseDescriptionLines(json: string | null): readonly string[] | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const lines: string[] = [];
  for (const paragraph of parsed) {
    if (typeof paragraph === "string") {
      lines.push(paragraph);
    } else if (Array.isArray(paragraph)) {
      for (const line of paragraph) {
        if (typeof line === "string") lines.push(line);
      }
    }
  }
  return lines;
}

function findTierCapMatches(lines: readonly string[]): readonly TierCapMatch[] {
  const matches: TierCapMatch[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const m = TIER_CAP_LINE.exec(line);
    if (!m) continue;
    const thresholdManwon = Number(m[2]);
    const capManwon = Number(m[3]);
    if (!isNonNegativeSafeInteger(thresholdManwon) || !isNonNegativeSafeInteger(capManwon)) continue;
    matches.push({ thresholdWon: thresholdManwon * 10000, capWon: capManwon * 10000, line });
  }
  return matches;
}

// ---------------------------------------------------------------------------
// 카드 단위 필드
// ---------------------------------------------------------------------------

/**
 * `cardAdId`/`cardName`/`issuerName`은 `RawCardRecord`가 이미 필수(빈 값 없음)로 보장하고,
 * `cardCode`/`sourceUrl`도 구조화된 컬럼을 그대로 옮기는 것뿐이라 해석이 필요 없다.
 * 그래서 이 출처는 항상 `parsed`다 — `cardType`처럼 원본에 대응하는 컬럼이 아예 없는
 * 값과 다르다(`cardType`을 왜 여기 두지 않는지는 `CardIdentity`의 문서 참고).
 */
function buildCardIdentity(
  card: RawCardRecord,
  extractedAt: string,
): NormalizationOutcome<CardIdentity> {
  const provenance: NormalizationProvenance = {
    sourceUrl: card.sourceUrl,
    cardAdId: card.cardAdId,
    benefitOrder: null,
    pieceIndex: null,
    originalCardText: `${card.cardName} / ${card.issuerName}`,
    originalBenefitText: null,
    originalConditionText: `card_ad_id="${card.cardAdId}", card_code="${card.cardCode ?? ""}", card_name="${card.cardName}", issuer_name="${card.issuerName}", source_url="${card.sourceUrl ?? ""}"`,
    extractedAt,
  };
  return {
    status: "parsed",
    confidence: "exact",
    value: {
      cardAdId: card.cardAdId,
      cardCode: card.cardCode,
      cardName: card.cardName,
      issuerName: card.issuerName,
      sourceUrl: card.sourceUrl,
    },
    provenance,
  };
}

/**
 * `annual_fee_domestic`/`annual_fee_international`에서 유효한 숫자를 모아 대표 연회비를
 * 정한다.
 *
 * - 숫자가 하나뿐이거나(한쪽만 존재), 둘 다 존재하고 값이 같으면 그 값을 쓴다.
 * - 둘 다 존재하고 값이 다르면(예: 국내전용/해외겸용 연회비가 다른 카드) `AnnualFee.amount`는
 *   값 하나뿐이라 어느 쪽을 대표값으로 써야 할지 표현할 수 없으므로 `unverified`로 남긴다.
 * - 숫자가 하나도 없으면 `unverified`(`NO_NUMERIC_VALUE_FOUND`)로 남긴다.
 *
 * `annual_fee_description`(브랜드/채널/모바일단독/가족카드 등 부가 설명)이 존재한다는
 * 사실 자체는 대표값 판단에 쓰지 않는다 — 실제 443장 데이터를 확인한 결과 이 설명의
 * 대부분은 모바일 단독카드·가족카드처럼 "다른 상품/발급형태"의 별도 비용을 설명할
 * 뿐이고, domestic/international 숫자 자체를 틀리게 만들지 않는다. description 원문은
 * 이전과 동일하게 `originalCardText`에 그대로 보존하고, description이 있었는데도
 * 숫자값을 대표값으로 채택했다는 판단 과정은 `originalConditionText`에 남긴다(아래).
 */
function buildAnnualFee(card: RawCardRecord, extractedAt: string) {
  const provenance = (conditionText: string): NormalizationProvenance => ({
    sourceUrl: card.sourceUrl,
    cardAdId: card.cardAdId,
    benefitOrder: null,
    pieceIndex: null,
    originalCardText: [card.annualFeeDomestic, card.annualFeeInternational, card.annualFeeDescription]
      .filter((v): v is string => v !== null)
      .join(" | "),
    originalBenefitText: null,
    originalConditionText: conditionText,
    extractedAt,
  });

  const domestic = parseWholeNumber(card.annualFeeDomestic);
  const international = parseWholeNumber(card.annualFeeInternational);
  const candidates = [domestic, international].filter((v): v is number => v !== null);
  const distinct = new Set(candidates);

  if (distinct.size === 1) {
    const amount = [...distinct][0] as number;
    // description이 있어도 숫자값 판단 자체는 바뀌지 않지만, 그 판단 과정을 trace에
    // 남긴다 — description 원문 자체는 위 `originalCardText`에 이미 보존돼 있으므로
    // 여기서는 "존재했지만 숫자값을 대표값으로 채택했다"는 사실만 짧게 덧붙인다.
    const descriptionNote =
      card.annualFeeDescription !== null
        ? " (annual_fee_description 존재 — domestic/international 숫자값을 대표값으로 채택함)"
        : "";
    return {
      status: "parsed" as const,
      confidence: "exact" as const,
      // firstYearWaived는 텍스트에서 추측하지 않는다(§8). 별도 근거가 없으면 false를
      // 기본값으로 둔다 — 이는 "텍스트를 읽고 추론"이 아니라 명시적인 기본 정책이다.
      value: { amount: asWon(amount), firstYearWaived: false },
      provenance: provenance(
        `annual_fee_domestic="${card.annualFeeDomestic ?? ""}", annual_fee_international="${card.annualFeeInternational ?? ""}"${descriptionNote}`,
      ),
    };
  }

  // "값이 하나도 없음"과 "서로 다른 값이 충돌함"은 다른 상황이라 reason code를 분리한다.
  if (distinct.size === 0) {
    return {
      status: "unverified" as const,
      reasonCode: "NO_NUMERIC_VALUE_FOUND" as const,
      provenance: provenance(
        `annual_fee_domestic="${card.annualFeeDomestic ?? ""}", annual_fee_international="${card.annualFeeInternational ?? ""}" 모두 확인할 수 없음`,
      ),
    };
  }

  return {
    status: "unverified" as const,
    reasonCode: "MULTIPLE_CONFLICTING_VALUES" as const,
    provenance: provenance(
      `annual_fee_domestic="${card.annualFeeDomestic ?? ""}", annual_fee_international="${card.annualFeeInternational ?? ""}"가 서로 다름`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Benefit row 처리
// ---------------------------------------------------------------------------

interface RowProcessingResult {
  readonly benefit: NormalizedBenefit;
  /** 이 row 전체가 unsupported로 빠졌을 때만 채워진다(카드 단위 경고용). */
  readonly wholeRowWarning: NormalizationWarning | null;
  /** 이 row에서 발견된 실적 구간 threshold 후보. 여러 row가 같은 threshold를 재확인할 수 있다. */
  readonly tierThresholds: readonly { readonly thresholdWon: number; readonly provenance: NormalizationProvenance }[];
}

function detectReward(
  summary: string,
  lines: readonly string[],
  provenanceFor: (conditionText: string) => NormalizationProvenance,
): NormalizationOutcome<NormalizedReward> {
  const combinedText = `${summary}\n${lines.join("\n")}`;

  // 명확한 범위 밖 신호를 rate/fixed 시도보다 먼저 확인한다 — "10% 할인"처럼 보여도
  // 실제로는 단위 기반/건당 조건이면 그 숫자만 뽑아 완전한 reward를 만들지 않는다.
  if (combinedText.includes("리터당")) {
    return { status: "unsupported", code: "UNIT_BASED_REWARD_EXACT", provenance: provenanceFor(combinedText) };
  }
  if (/건당|1회\s*[\d,]+\s*원/.test(combinedText)) {
    return { status: "unsupported", code: "PER_TRANSACTION_MINIMUM", provenance: provenanceFor(combinedText) };
  }

  // 단순 퍼센트: "10% 할인", "5% 할인 캐시백"처럼 정수 %와 할인/캐시백 단어가 함께 있는 경우만.
  // 소수 퍼센트("1.5%")는 이 정수 전용 패턴에 매칭되지 않아 그대로 unverified로 남는다
  // (§11 "소수 퍼센트나 복합 rate는 이번 단계에서 억지로 처리하지 마라").
  const percentMatch = /(\d+)%/.exec(summary);
  const hasDiscountWord = summary.includes("할인");
  const hasCashbackWord = summary.includes("캐시백");
  if (percentMatch && (hasDiscountWord || hasCashbackWord)) {
    const percent = Number(percentMatch[1]);
    if (isNonNegativeSafeInteger(percent)) {
      const rateBps = asBasisPoints(percent * 100);
      const form: "discount" | "cashback" = hasCashbackWord ? "cashback" : "discount";
      const p = provenanceFor(`benefit_summary="${summary}"`);
      return {
        status: "parsed",
        confidence: "exact",
        value: {
          kind: "rate",
          rateBps: { status: "parsed", value: rateBps, confidence: "exact", provenance: p },
          currency: { status: "parsed", value: { type: "won", form }, confidence: "exact", provenance: p },
        },
        provenance: p,
      };
    }
  }

  // 명확한 월 정액: "매월 3,000원 캐시백" / "월 5,000원 할인"처럼 월 단위가 명시된 경우만.
  // "건당"/"1회" 문맥은 위에서 이미 걸러졌으므로 여기 도달했다면 월 단위로 본다.
  const fixedMatch = /(?:매월|월)\s*([\d,]+)\s*원\s*(?:할인|캐시백)/.exec(combinedText);
  if (fixedMatch) {
    const amount = Number(fixedMatch[1].replace(/,/g, ""));
    if (isNonNegativeSafeInteger(amount)) {
      const p = provenanceFor(`"${fixedMatch[0]}"`);
      return {
        status: "parsed",
        confidence: "exact",
        value: {
          kind: "fixed",
          monthlyAmount: { status: "parsed", value: asWon(amount), confidence: "exact", provenance: p },
        },
        provenance: p,
      };
    }
  }

  return {
    status: "unverified",
    reasonCode: "NO_NUMERIC_VALUE_FOUND",
    provenance: provenanceFor(combinedText),
  };
}

/**
 * "국내외 이용금액 합산"처럼 국내/해외 실적이나 소비가 하나의 조건으로 결합되는
 * 경우만 진짜 "결합"이다. "해외이용 5% 적립"처럼 대상이 해외 하나로 끝나는 경우는
 * 결합이 아니라 단순 `overseas` 대상이다(Case A vs Case B, 실제 문장 구조로 구분).
 */
function isDomesticOverseasCombination(text: string): boolean {
  if (text.includes("국내외")) return true;
  return /국내/.test(text) && /해외/.test(text) && /합산|통합/.test(text);
}

function detectTarget(
  rawCategory: string | null,
  lines: readonly string[],
  provenanceFor: (conditionText: string) => NormalizationProvenance,
): { outcome: NormalizationOutcome<CategoryTarget>; unsupportedCode: UnsupportedConditionCode | null } {
  const combinedText = lines.join("\n");

  // 특정 브랜드 자체가 대상의 핵심인 경우만 MERCHANT_SPECIFIC. "제외" 문구가 있다는
  // 것만으로는(예: 대형마트의 SSM/온라인몰 제외) 이 코드를 쓰지 않는다 — target 자체는
  // 대체로 해석 가능하고, 정확한 경계(제외 조건)를 확정 못 하는 것은 별개 문제라서
  // 아래에서 `AMBIGUOUS_TARGET_CATEGORY`로 따로 다룬다.
  if (NAMED_MERCHANT_MARKERS.some((name) => combinedText.includes(name))) {
    const code: UnsupportedConditionCode = "MERCHANT_SPECIFIC";
    return {
      outcome: { status: "unsupported", code, provenance: provenanceFor(combinedText) },
      unsupportedCode: code,
    };
  }
  if (combinedText.includes("간편결제")) {
    const code: UnsupportedConditionCode = "PAYMENT_METHOD_RESTRICTED";
    return {
      outcome: { status: "unsupported", code, provenance: provenanceFor(combinedText) },
      unsupportedCode: code,
    };
  }
  if (/1차년도|2차년도/.test(combinedText)) {
    const code: UnsupportedConditionCode = "ANNIVERSARY_YEAR_CONDITION";
    return {
      outcome: { status: "unsupported", code, provenance: provenanceFor(combinedText) },
      unsupportedCode: code,
    };
  }
  if (isDomesticOverseasCombination(combinedText)) {
    const code: UnsupportedConditionCode = "DOMESTIC_OVERSEAS_COMBINATION";
    return {
      outcome: { status: "unsupported", code, provenance: provenanceFor(combinedText) },
      unsupportedCode: code,
    };
  }

  // Case A: 국내/해외 결합이 아니라 대상이 해외 하나뿐인 경우. `category.ts`가 이미
  // `overseas`를 (임시) 카테고리로 인정하고 있으므로 그대로 parsed로 다룬다.
  if (combinedText.includes("해외")) {
    return {
      outcome: {
        status: "parsed",
        confidence: "exact",
        value: { type: "categories", categories: ["overseas"] },
        provenance: provenanceFor(`"해외" 대상, 국내/해외 결합 신호 없음: ${combinedText}`),
      },
      unsupportedCode: null,
    };
  }

  const mapped = rawCategory !== null ? CATEGORY_BY_RAW_LABEL.get(rawCategory) : undefined;
  const hasUnresolvedExclusion = combinedText.includes("제외");

  if (mapped !== undefined && !hasUnresolvedExclusion) {
    return {
      outcome: {
        status: "parsed",
        confidence: "exact",
        value: { type: "categories", categories: [mapped] },
        provenance: provenanceFor(`benefit_category="${rawCategory ?? ""}"`),
      },
      unsupportedCode: null,
    };
  }

  // 카테고리 자체를 못 찾았거나(매핑표에 없음), 찾았어도 "제외" 조건이 있어 정확한
  // 경계를 확정할 수 없는 경우. 둘 다 `unverified`이지 `unsupported`가 아니다 — 대상
  // 개념 자체를 이해하지 못한 게 아니라, 신뢰할 수 있는 범위로 좁히지 못했을 뿐이다.
  return {
    outcome: {
      status: "unverified",
      reasonCode: "AMBIGUOUS_TARGET_CATEGORY",
      provenance: provenanceFor(
        hasUnresolvedExclusion
          ? `benefit_category="${rawCategory ?? ""}"이지만 "제외" 조건이 있어 정확한 대상 범위를 확정할 수 없음: ${combinedText}`
          : `benefit_category="${rawCategory ?? ""}"가 매핑표에 없음`,
      ),
    },
    unsupportedCode: null,
  };
}

// ---------------------------------------------------------------------------
// Piece 판정 (재사용 가능한 순수 함수)
// ---------------------------------------------------------------------------

function assertNeverPerkKind(value: never): never {
  throw new Error(`Unexpected perkKind: ${JSON.stringify(value)}`);
}

/**
 * piece를 구성하는 모든 필드의 outcome을 한 배열로 모은다. `kind`/`perkKind`에 따라
 * 실제 필드 구성이 다르므로(스펜딩 혜택 vs 부가 혜택의 세 variant) 여기서 통일한다.
 *
 * 이 함수는 순수하며 `NormalizedCard`나 CSV를 전혀 모른다 — `NormalizedBenefitPiece` 하나만
 * 보고 판정하므로, 이번 단계의 `normalizeCard.ts`뿐 아니라 다음 단계의 `toDomainCard()`도
 * 그대로 재사용할 수 있다.
 */
export function getPieceFieldOutcomes(piece: NormalizedBenefitPiece): readonly NormalizationOutcome<unknown>[] {
  if (piece.kind === "spendingBenefit") {
    return [
      piece.name,
      piece.requiredTierId,
      piece.target,
      piece.minMonthlySpend,
      piece.reward,
      piece.limits,
      piece.sharedCapId,
    ];
  }
  switch (piece.perkKind) {
    case "voucher":
    case "gift":
      return [piece.name, piece.requiredTierId, piece.value, piece.frequency];
    case "lounge":
      return [piece.name, piece.requiredTierId, piece.visitsPerYear, piece.valuePerVisit];
    case "signupBonus":
      return [piece.name, piece.requiredTierId, piece.value, piece.requirement];
    default:
      return assertNeverPerkKind(piece);
  }
}

/** 모든 필드가 `parsed`일 때만 `true` — 다음 단계가 실제 Domain object를 만들 수 있는 조건. */
export function isPieceFullyParsed(piece: NormalizedBenefitPiece): boolean {
  return getPieceFieldOutcomes(piece).every((outcome) => outcome.status === "parsed");
}

/** piece의 필드 중 `unsupported`가 있으면 그중 먼저 발견된 code를, 없으면 `null`을 돌려준다. */
export function findUnsupportedCode(piece: NormalizedBenefitPiece): UnsupportedConditionCode | null {
  for (const outcome of getPieceFieldOutcomes(piece)) {
    if (outcome.status === "unsupported") return outcome.code;
  }
  return null;
}

function processBenefitRow(
  card: RawCardRecord,
  raw: RawBenefitRecord,
  benefitOrder: number,
  extractedAt: string,
): RowProcessingResult {
  const provenanceFor = (
    conditionText: string,
    pieceIndex: number | null,
    originalBenefitText: string | null,
  ): NormalizationProvenance => ({
    sourceUrl: card.sourceUrl,
    cardAdId: card.cardAdId,
    benefitOrder,
    pieceIndex,
    originalCardText: null,
    originalBenefitText,
    originalConditionText: conditionText,
    extractedAt,
  });

  const lines = parseDescriptionLines(raw.benefitDescriptionsJson);
  const summary = raw.benefitSummary ?? "";
  const fullBenefitText = lines !== null ? lines.join("\n") : (raw.benefitDescription ?? "");

  if (lines === null) {
    const provenance = provenanceFor("benefit_descriptions_json 파싱 실패 또는 예상 구조와 다름", null, null);
    return {
      benefit: { sourceBenefitOrder: benefitOrder, pieces: [] },
      wholeRowWarning: { code: "UNVERIFIED_ROW", message: "benefit_descriptions_json을 해석할 수 없습니다.", provenance },
      tierThresholds: [],
    };
  }

  // 이 카드에서 실제로 확인된 "신규회원 한시 이벤트" 패턴. 소비에 연동된 반복 혜택이
  // 아니라 특정 기간의 1회성 프로모션이라 전체 row를 범위 밖으로 둔다.
  if (raw.benefitCategory === "연회비지원" && lines.some((l) => l.includes("이벤트 기간"))) {
    const provenance = provenanceFor(fullBenefitText.slice(0, 200), null, fullBenefitText);
    return {
      benefit: { sourceBenefitOrder: benefitOrder, pieces: [] },
      wholeRowWarning: { code: "NEW_MEMBER_EVENT", message: "기간 한정 신규회원 이벤트로 범위 밖 처리", provenance },
      tierThresholds: [],
    };
  }

  const pieceProvenanceFor = (conditionText: string): NormalizationProvenance =>
    provenanceFor(conditionText, 0, fullBenefitText);

  const tierCapMatches = findTierCapMatches(lines);
  const tierThresholds = tierCapMatches.map((m) => ({
    thresholdWon: m.thresholdWon,
    provenance: pieceProvenanceFor(`"${m.line}"`),
  }));

  // "합산"만으로는 판단하지 않는다 — "해외매출을 합산하여" 같은 문장은 통합 한도가
  // 아니라 단순히 월별 매출 집계를 설명하는 것이라 false positive가 난다(실측으로
  // 확인됨: row6). "통합"은 이 카드에서 실제 통합 한도 문구("음식/커피/편의점/약국
  // 통합", "학원/피트니스 통합")에서만 일관되게 나타나 더 신뢰할 수 있는 신호다.
  const hasSharedGroupSignal = fullBenefitText.includes("통합");

  let requiredTierId: NormalizationOutcome<string | null>;
  if (tierCapMatches.length === 1) {
    const m = tierCapMatches[0];
    if (m) {
      requiredTierId = {
        status: "parsed",
        confidence: "exact",
        value: createPerformanceTierId(card.cardAdId, asWon(m.thresholdWon)),
        provenance: pieceProvenanceFor(`"${m.line}"`),
      };
    } else {
      requiredTierId = { status: "unverified", reasonCode: "AMBIGUOUS_TIER_VALUE", provenance: pieceProvenanceFor(fullBenefitText) };
    }
  } else {
    // 0개(명시적 구간 문구 없음) 또는 2개 이상(여러 구간이 한 benefit에 섞여 있어
    // 이번 단계의 단순 모델로는 어느 것을 요구 구간으로 볼지 결정할 수 없음).
    requiredTierId = {
      status: "unverified",
      reasonCode: "AMBIGUOUS_TIER_VALUE",
      provenance: pieceProvenanceFor(
        tierCapMatches.length === 0
          ? "명시적인 구간 문구를 찾지 못함"
          : `구간이 ${tierCapMatches.length}개 발견되어 하나로 결정할 수 없음: ${tierCapMatches.map((m) => `"${m.line}"`).join(" / ")}`,
      ),
    };
  }

  // "월 5회", "일 1회", "연 12회"처럼 금액이 아니라 횟수로 상한을 두는 조건. 요율/대상
  // 자체는 맞을 수 있지만 실제 월 혜택은 결제 건수에 의존하므로 원화 한도로 표현할 수
  // 없다 — `limits`(원화 상한)를 확정하지 않고 unsupported로 남긴다.
  const usageCountLimitMatch = /(?:월|일|연)\s*\d+\s*회/.exec(fullBenefitText);

  let limits: NormalizationOutcome<{ monthlyRewardCap: Won | null; monthlyEligibleSpendCap: Won | null }>;
  let sharedCapId: NormalizationOutcome<string | null>;
  if (usageCountLimitMatch) {
    const reason = pieceProvenanceFor(`횟수 제한 문구 발견: "${usageCountLimitMatch[0]}"`);
    limits = { status: "unsupported", code: "USAGE_COUNT_LIMIT", provenance: reason };
    sharedCapId = { status: "unsupported", code: "USAGE_COUNT_LIMIT", provenance: reason };
  } else if (hasSharedGroupSignal) {
    // "통합"/"합산": 여러 benefit이 한도를 나눠 쓴다는 뜻이지만, 어느 benefit들이
    // 그룹인지는 카드 전체를 훑어야 알 수 있다. 이번 단계는 그 grouping을 구현하지
    // 않으므로 여기서 발견한 숫자를 이 benefit만의 독립된 한도로 단정하지 않는다.
    const reason = pieceProvenanceFor(
      `한도 문구에 "통합"/"합산"이 포함되어 있어 이 benefit만의 독립된 한도인지 확인할 수 없음: ${fullBenefitText}`,
    );
    limits = { status: "unverified", reasonCode: "AMBIGUOUS_CAP_VALUE", provenance: reason };
    sharedCapId = { status: "unverified", reasonCode: "AMBIGUOUS_CAP_VALUE", provenance: reason };
  } else if (tierCapMatches.length === 1) {
    const m = tierCapMatches[0];
    if (m) {
      limits = {
        status: "parsed",
        confidence: "exact",
        value: { monthlyRewardCap: asWon(m.capWon), monthlyEligibleSpendCap: null },
        provenance: pieceProvenanceFor(`"${m.line}"`),
      };
    } else {
      limits = { status: "unverified", reasonCode: "AMBIGUOUS_CAP_VALUE", provenance: pieceProvenanceFor(fullBenefitText) };
    }
    sharedCapId = {
      status: "parsed",
      confidence: "exact",
      value: null,
      provenance: pieceProvenanceFor('"통합"/"합산" 문구 없음 — 이 benefit 단독 한도'),
    };
  } else {
    limits = {
      status: "unverified",
      reasonCode: "AMBIGUOUS_CAP_VALUE",
      provenance: pieceProvenanceFor(
        tierCapMatches.length === 0
          ? "명시적인 한도 문구를 찾지 못함"
          : `구간별로 한도가 ${tierCapMatches.length}개 발견되어(요율은 같을 수 있음) 이번 단계의 단순 모델로 하나의 한도로 결정할 수 없음`,
      ),
    };
    sharedCapId = {
      status: "parsed",
      confidence: "exact",
      value: null,
      provenance: pieceProvenanceFor('"통합"/"합산" 문구 없음'),
    };
  }

  const minMonthlySpend: NormalizationOutcome<Won | null> = fullBenefitText.includes("최소")
    ? {
        status: "unverified",
        reasonCode: "AMBIGUOUS_CAP_VALUE",
        provenance: pieceProvenanceFor('"최소" 문구가 있어 별도 최소 이용금액 조건 여부를 이번 단계에서 판단하지 않음'),
      }
    : {
        status: "parsed",
        confidence: "exact",
        value: null,
        provenance: pieceProvenanceFor('"최소" 문구 없음 — 구간 조건 외 별도 최소 이용금액 없음'),
      };

  const { outcome: target } = detectTarget(
    raw.benefitCategory,
    lines,
    pieceProvenanceFor,
  );
  const reward = detectReward(summary, lines, pieceProvenanceFor);

  // priority/exclusiveGroupId는 이 piece 타입에 없다 — 원문에서 파싱하는 값이 아니라
  // 배타 그룹을 실제로 구성하는 단계(다음 단계)에서 결정할 값이기 때문이다. 자세한
  // 이유는 `NormalizedSpendingBenefitPiece`의 문서 참고.
  const piece: NormalizedSpendingBenefitPiece = {
    kind: "spendingBenefit",
    benefitId: createBenefitId(card.cardAdId, benefitOrder, 0),
    name: { status: "parsed", confidence: "exact", value: summary, provenance: pieceProvenanceFor(`benefit_summary="${summary}"`) },
    requiredTierId,
    target,
    minMonthlySpend,
    reward,
    limits,
    sharedCapId,
    provenance: pieceProvenanceFor(fullBenefitText.slice(0, 200)),
  };

  const pieces: readonly NormalizedBenefitPiece[] = [piece];

  // 이 row가 뭔가 확실한 unsupported 조건을 담고 있었는지(카드 단위 경고에 참고용으로 남김).
  // `piece`의 모든 필드를 훑는 공용 판정 함수를 쓴다 — 특정 필드 몇 개만 손으로 나열하지
  // 않으므로, 나중에 어떤 필드가 unsupported를 반환하게 되어도 여기서 빠지지 않는다.
  const dominantUnsupportedCode = findUnsupportedCode(piece);

  return {
    benefit: { sourceBenefitOrder: benefitOrder, pieces },
    wholeRowWarning:
      dominantUnsupportedCode !== null
        ? {
            code: dominantUnsupportedCode,
            message: "일부 필드가 범위 밖 조건으로 unsupported 처리됨(피스 자체는 보존됨)",
            provenance: pieceProvenanceFor(fullBenefitText.slice(0, 200)),
          }
        : null,
    tierThresholds,
  };
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * `RawCardRecord`와 그 카드의 `RawBenefitRecord[]`로부터 `NormalizedCard`를 만든다.
 * `benefits`에는 해당 카드의 benefit만 전달된다고 가정하며, 전체 CSV를 다시 훑거나
 * 파일을 읽지 않는다.
 */
export function normalizeCard(card: RawCardRecord, benefits: readonly RawBenefitRecord[]): NormalizedCard {
  const extractedAt = new Date().toISOString();

  const cardIdentity = buildCardIdentity(card, extractedAt);
  const annualFee = buildAnnualFee(card, extractedAt);

  const normalizedBenefits: NormalizedBenefit[] = [];
  const cardLevelWarnings: NormalizationWarning[] = [];
  const tierDiscoveries = new Map<number, NormalizationProvenance[]>();

  for (const raw of benefits) {
    const benefitOrder = Number(raw.benefitOrder);
    if (!Number.isSafeInteger(benefitOrder)) {
      cardLevelWarnings.push({
        code: "INVALID_BENEFIT_ORDER",
        message: `benefit_order를 숫자로 변환할 수 없습니다: "${raw.benefitOrder}"`,
        provenance: null,
      });
      continue;
    }

    const result = processBenefitRow(card, raw, benefitOrder, extractedAt);
    normalizedBenefits.push(result.benefit);
    if (result.wholeRowWarning !== null) cardLevelWarnings.push(result.wholeRowWarning);
    for (const t of result.tierThresholds) {
      const existing = tierDiscoveries.get(t.thresholdWon);
      if (existing) existing.push(t.provenance);
      else tierDiscoveries.set(t.thresholdWon, [t.provenance]);
    }
  }

  const performanceTiers: NormalizedPerformanceTier[] = [...tierDiscoveries.entries()]
    .sort(([a], [b]) => a - b)
    .map(([thresholdWon, provenanceList]) => {
      const first = provenanceList[0];
      return {
        tierId: createPerformanceTierId(card.cardAdId, asWon(thresholdWon)),
        minPreviousMonthSpend: {
          status: "parsed",
          confidence: "exact",
          value: asWon(thresholdWon),
          provenance: first as NormalizationProvenance,
        },
        provenance: provenanceList,
      };
    });

  return {
    cardAdId: card.cardAdId,
    card: cardIdentity,
    annualFee,
    performanceTiers,
    sharedCaps: [],
    benefits: normalizedBenefits,
    cardLevelWarnings,
  };
}
