import type {
  NormalizationOutcome,
  NormalizedBenefitPiece,
  NormalizedCard,
  NormalizedPerformanceTier,
  NormalizedPerkPiece,
  NormalizedSpendingBenefitPiece,
} from "./normalizeTypes";
import { findUnsupportedCode, isPieceFullyParsed } from "./normalizeCard";
import type {
  BenefitId,
  Card,
  CardId,
  CardSource,
  CoreConditionField,
  PerformanceTier,
  PerformanceTierId,
  PerkBenefit,
  SharedCapId,
  SpendingBenefit,
  UnverifiedCondition,
} from "../recommendation/types";

/**
 * `NormalizedCard` → Domain `Card` 변환.
 *
 * ```text
 * NormalizedCard
 *   ↓ toDomainCard()   ← 이 파일
 * Card
 *   ↓ validateCard()   (recommendation)
 * ValidatedCard
 * ```
 *
 * 핵심 원칙: parsed 값을 추정하거나 fallback으로 채우지 않는다. `Card`가 요구하는 필수
 * 필드를 정규화 결과가 확정하지 못하면, 이 함수는 `Card`를 만들지 않고 구조화된 실패
 * 사유를 반환한다("failed"). 어떤 필드도 임의의 기본값(빈 문자열, 0, "credit" 등)으로
 * 채우지 않는다.
 *
 * `priority`/`exclusiveGroupId`는 원문에서 파싱되는 값이 아니라 배타 그룹을 실제로
 * 구성해야 결정되는 값이다(`normalizeCard.ts`의 `NormalizedSpendingBenefitPiece` 문서
 * 참고). 이번 단계는 그 그룹 구성 로직이 없으므로 모든 `SpendingBenefit`에 동일한
 * placeholder(`priority = 0`, `exclusiveGroupId = null`)를 쓴다 — 이건 "계산된 우선순위"가
 * 아니라 "아직 경쟁 관계를 모른다"는 뜻이며, 구간별 요율 분해/배타 그룹 로직이 생기면
 * 이 자리를 교체해야 한다.
 */

// ---------------------------------------------------------------------------
// 실패 사유 / 결과 타입
// ---------------------------------------------------------------------------

/**
 * `Card`를 만들 수 없는 구조화된 사유.
 *
 * - `ANNUAL_FEE_UNVERIFIED`: `NormalizedCard.annualFee`가 `parsed`가 아님.
 * - `SOURCE_URL_MISSING`: `CardIdentity.sourceUrl`이 `null`. Domain `CardSource.sourceUrl`은
 *   `string`(non-null)이라 빈 문자열이나 임의 URL로 채울 수 없다.
 * - `CARD_TYPE_UNKNOWN`: `Card.cardType`은 `"credit" | "check"` 중 하나가 필수이고 "모름"
 *   상태가 없는데, 현재 CSV에는 이를 판단할 컬럼이 전혀 없고 `NormalizedCard`에도 대응하는
 *   필드가 없다. 그래서 이 사유는 이번 단계에서 **모든 카드에 대해 항상** 발생한다 —
 *   버그가 아니라, cardType 정보원이 아직 없다는 사실을 그대로 반영한 것이다. 다른 데이터
 *   소스가 추가되거나 Domain `CardType`이 "모름" 상태를 표현할 수 있게 바뀌기 전까지는
 *   `toDomainCard()`가 `success`를 반환할 수 없다.
 */
export type ToDomainCardFailureReason =
  | { readonly code: "ANNUAL_FEE_UNVERIFIED" }
  | { readonly code: "SOURCE_URL_MISSING" }
  | { readonly code: "CARD_TYPE_UNKNOWN" };

export type ToDomainCardResult =
  | { readonly status: "success"; readonly card: Card }
  | {
      readonly status: "failed";
      readonly reasons: readonly [ToDomainCardFailureReason, ...ToDomainCardFailureReason[]];
    };

// ---------------------------------------------------------------------------
// 불변식 검사 / ID 캐스팅 helper
// ---------------------------------------------------------------------------

/**
 * `status === "parsed"`임을 이미 확인한 자리에서만 호출한다. 이 함수 자체는 그 확인을
 * 하지 않고, 위반되면(정규화 결과가 이 파일이 기대하는 불변식을 어겼다면) throw한다 —
 * 조용히 잘못된 값을 반환하는 대신 시끄럽게 실패한다.
 */
function unwrapParsed<T>(outcome: NormalizationOutcome<T>): T {
  if (outcome.status !== "parsed") {
    throw new Error(`toDomainCard: 불변식 위반 — parsed여야 하는 자리에서 status="${outcome.status}"를 만남`);
  }
  return outcome.value;
}

function asCardId(value: string): CardId {
  return value as CardId;
}

function asBenefitId(value: string): BenefitId {
  return value as BenefitId;
}

function asPerformanceTierId(value: string): PerformanceTierId {
  return value as PerformanceTierId;
}

function asSharedCapId(value: string): SharedCapId {
  return value as SharedCapId;
}

function asPerformanceTierIdOrNull(value: string | null): PerformanceTierId | null {
  return value === null ? null : asPerformanceTierId(value);
}

function assertNeverPerkKind(value: never): never {
  throw new Error(`toDomainCard: 예상하지 못한 perkKind: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// performanceTiers
// ---------------------------------------------------------------------------

/**
 * `NormalizedPerformanceTier` → Domain `PerformanceTier`.
 *
 * `tierId`는 `createPerformanceTierId`가 만든 문자열을 그대로 브랜드 캐스팅한다. `name`은
 * 원문에 없는 필드라 threshold 금액으로부터 사람이 읽을 라벨을 합성한다 — 이미 확정된
 * 숫자를 문구로 바꾸는 것뿐이라 새로운 사실을 추정하는 것이 아니다. 이 참조를
 * `Benefit.requiredTierId`가 실제로 가리키는지는 여기서 검증하지 않는다 — 그건
 * `validateCard()`의 `INVALID_TIER_REFERENCE` 책임이다.
 */
function buildPerformanceTiers(tiers: readonly NormalizedPerformanceTier[]): readonly PerformanceTier[] {
  return tiers.map((tier) => {
    const minPreviousMonthSpend = unwrapParsed(tier.minPreviousMonthSpend);
    return {
      id: asPerformanceTierId(tier.tierId),
      name: `전월실적 ${minPreviousMonthSpend}원 이상`,
      minPreviousMonthSpend,
    };
  });
}

// ---------------------------------------------------------------------------
// Piece → Benefit 변환 + unverifiedConditions 매핑
// ---------------------------------------------------------------------------

function buildSpendingBenefit(piece: NormalizedSpendingBenefitPiece): SpendingBenefit {
  const name = unwrapParsed(piece.name);
  const requiredTierId = asPerformanceTierIdOrNull(unwrapParsed(piece.requiredTierId));
  const target = unwrapParsed(piece.target);
  const minMonthlySpend = unwrapParsed(piece.minMonthlySpend);
  const limits = unwrapParsed(piece.limits);
  const sharedCapIdValue = unwrapParsed(piece.sharedCapId);
  const sharedCapId = sharedCapIdValue === null ? null : asSharedCapId(sharedCapIdValue);
  const reward = unwrapParsed(piece.reward);

  const base = {
    id: asBenefitId(piece.benefitId),
    name,
    // placeholder — 위 모듈 docstring 참고. 실제 배타 그룹 로직이 생기면 교체한다.
    priority: 0,
    requiredTierId,
    target,
    minMonthlySpend,
    limits,
    sharedCapId,
    exclusiveGroupId: null,
  };

  // `reward`(외곽 outcome)가 parsed라는 것은 `detectReward()`의 구현상 rateBps/currency 또는
  // monthlyAmount도 항상 함께 parsed임을 뜻한다(그렇지 않은 조합은 애초에 만들어지지 않는다).
  // 그 내부 불변식이 깨지면 아래 `unwrapParsed`가 조용히 넘어가지 않고 throw한다.
  if (reward.kind === "rate") {
    return {
      ...base,
      kind: "rate",
      rateBps: unwrapParsed(reward.rateBps),
      currency: unwrapParsed(reward.currency),
    };
  }
  return {
    ...base,
    kind: "fixed",
    monthlyAmount: unwrapParsed(reward.monthlyAmount),
  };
}

function buildPerk(piece: NormalizedPerkPiece): PerkBenefit {
  const id = asBenefitId(piece.benefitId);
  const name = unwrapParsed(piece.name);
  const requiredTierId = asPerformanceTierIdOrNull(unwrapParsed(piece.requiredTierId));

  switch (piece.perkKind) {
    case "voucher":
    case "gift":
      return {
        kind: piece.perkKind,
        id,
        name,
        requiredTierId,
        value: unwrapParsed(piece.value),
        frequency: unwrapParsed(piece.frequency),
      };
    case "lounge":
      return {
        kind: "lounge",
        id,
        name,
        requiredTierId,
        visitsPerYear: unwrapParsed(piece.visitsPerYear),
        valuePerVisit: unwrapParsed(piece.valuePerVisit),
      };
    case "signupBonus":
      return {
        kind: "signupBonus",
        id,
        name,
        requiredTierId,
        value: unwrapParsed(piece.value),
        requirement: unwrapParsed(piece.requirement),
      };
    default:
      return assertNeverPerkKind(piece);
  }
}

/**
 * unverified 필드가 있는 piece에서, 그 필드가 대응하는 `CoreConditionField`를 모은다
 * (같은 필드가 여러 개면 중복 없이 하나로 묶는다).
 *
 * 의도적으로 `getPieceFieldOutcomes()`를 재사용하지 않는다 — 그 함수는 필드 이름 없이
 * outcome만 모으도록 설계되어 있는데(순수 판정 용도), 여기서는 "어느 필드인지"가 꼭
 * 필요하다. 서로 다른 두 함수가 같은 필드 순서를 몰래 공유해야 하는 위험한 결합을
 * 만들지 않기 위해 이름 있는 필드를 직접 나열한다.
 *
 * `name`이나 부가 혜택의 `value`/`frequency`/`visitsPerYear`/`valuePerVisit`/`requirement`처럼
 * 대응하는 `CoreConditionField`가 없는 필드는 건너뛴다 — 억지로 기존 code 중 하나에
 * 끼워 맞추면(예: cardType을 "숫자 못 찾음"으로 위장했던 것과 같은 문제) 잘못된 사유를
 * 기록하게 된다. `CoreConditionField`에 새 값을 추가하는 것은 이번 범위 밖이다.
 */
function collectUnverifiedCoreFields(piece: NormalizedBenefitPiece): readonly CoreConditionField[] {
  const entries: readonly (readonly [NormalizationOutcome<unknown>, CoreConditionField | null])[] =
    piece.kind === "spendingBenefit"
      ? [
          [piece.name, null],
          [piece.requiredTierId, "performanceTiers"],
          [piece.target, "target"],
          [piece.minMonthlySpend, "minSpend"],
          [piece.reward, "rate"],
          [piece.limits, "limits"],
          [piece.sharedCapId, "limits"],
        ]
      : perkFieldEntries(piece);

  const found = new Set<CoreConditionField>();
  for (const [outcome, field] of entries) {
    if (outcome.status === "unverified" && field !== null) found.add(field);
  }
  return [...found];
}

function perkFieldEntries(
  piece: NormalizedPerkPiece,
): readonly (readonly [NormalizationOutcome<unknown>, CoreConditionField | null])[] {
  const common: readonly (readonly [NormalizationOutcome<unknown>, CoreConditionField | null])[] = [
    [piece.name, null],
    [piece.requiredTierId, "performanceTiers"],
  ];
  switch (piece.perkKind) {
    case "voucher":
    case "gift":
      return [...common, [piece.value, null], [piece.frequency, null]];
    case "lounge":
      return [...common, [piece.visitsPerYear, null], [piece.valuePerVisit, null]];
    case "signupBonus":
      return [...common, [piece.value, null], [piece.requirement, null]];
    default:
      return assertNeverPerkKind(piece);
  }
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * `NormalizedCard`를 Domain `Card`로 변환한다.
 *
 * - fully parsed piece만 `spendingBenefits`/`perks`에 들어간다(`isPieceFullyParsed` 재사용).
 * - `unsupported` 필드가 있는 piece는 Domain에 전혀 반영하지 않는다(`findUnsupportedCode`
 *   재사용) — `unverifiedConditions`에도 넣지 않는다. `unsupported`는 "이 카드를 못 믿음"이
 *   아니라 "이 조건은 아직 계산 범위 밖"이라는 뜻이기 때문이다.
 * - `unsupported`는 없지만 unverified 필드가 있는 piece는 `unverifiedConditions`에 기록한다.
 * - `annualFee`가 `parsed`가 아니거나 `sourceUrl`이 `null`이거나 `cardType`을 결정할 수 없으면
 *   `Card`를 만들지 않고 `failed`를 반환한다. 어떤 필드도 임의 값으로 채우지 않는다.
 */
export function toDomainCard(normalized: NormalizedCard): ToDomainCardResult {
  // `NormalizedCard.card`는 현재 `normalizeCard()` 구현상 항상 parsed다(§ CardIdentity 문서).
  // 그렇지 않다면 이 함수가 기대하는 불변식이 깨진 것이므로 조용히 넘어가지 않고 throw한다.
  const cardIdentity = unwrapParsed(normalized.card);

  const reasons: ToDomainCardFailureReason[] = [];
  if (normalized.annualFee.status !== "parsed") {
    reasons.push({ code: "ANNUAL_FEE_UNVERIFIED" });
  }
  if (cardIdentity.sourceUrl === null) {
    reasons.push({ code: "SOURCE_URL_MISSING" });
  }
  // cardType: CSV에도 NormalizedCard에도 이 값을 판단할 근거가 전혀 없다. 추정하거나
  // 기본값을 넣지 않으므로, 이번 단계에서는 이 사유가 모든 카드에 대해 항상 발생한다.
  reasons.push({ code: "CARD_TYPE_UNKNOWN" });

  if (reasons.length > 0) {
    return {
      status: "failed",
      reasons: reasons as unknown as readonly [ToDomainCardFailureReason, ...ToDomainCardFailureReason[]],
    };
  }

  // 아래는 위 실패 사유가 전부 해소된 뒤에만(현재는 cardType 때문에 도달하지 않는다)
  // 실행되는, 완전히 구현된 성공 경로다.
  const annualFee = unwrapParsed(normalized.annualFee);
  // 위에서 SOURCE_URL_MISSING이 없었을 때만 여기 도달하므로 null일 수 없다 — TypeScript가
  // 그 사실을 이 지점까지 이어서 알 수는 없으므로 명시적으로 좁힌다(조용히 캐스팅하지 않는다).
  const sourceUrl = cardIdentity.sourceUrl;
  if (sourceUrl === null) {
    throw new Error("toDomainCard: 불변식 위반 — SOURCE_URL_MISSING 실패 이후에도 sourceUrl이 null");
  }

  const spendingBenefits: SpendingBenefit[] = [];
  const perks: PerkBenefit[] = [];
  const unverifiedConditions: UnverifiedCondition[] = [];

  for (const benefit of normalized.benefits) {
    for (const piece of benefit.pieces) {
      if (isPieceFullyParsed(piece)) {
        if (piece.kind === "spendingBenefit") spendingBenefits.push(buildSpendingBenefit(piece));
        else perks.push(buildPerk(piece));
        continue;
      }
      if (findUnsupportedCode(piece) !== null) {
        // unsupported: Domain에 반영하지 않는다. 원본 provenance는 NormalizedCard 쪽에
        // 이미 남아 있으므로 여기서 추가로 기록하지 않는다.
        continue;
      }
      for (const field of collectUnverifiedCoreFields(piece)) {
        unverifiedConditions.push({ field, benefitId: asBenefitId(piece.benefitId) });
      }
    }
  }

  const source: CardSource = {
    sourceUrl,
    // 기계 파싱 시각(extractedAt)을 사람 검증 시각으로 자동 승격하지 않는다.
    verifiedAt: null,
  };

  const card: Card = {
    id: asCardId(cardIdentity.cardAdId),
    issuer: cardIdentity.issuerName,
    name: cardIdentity.cardName,
    // 이 라인에는 절대 도달하지 않는다 — 위에서 CARD_TYPE_UNKNOWN을 항상 실패 사유로
    // 반환하기 때문이다. TypeScript가 `cardType`이 필수임을 강제하므로, 이 함수가
    // 완전해지려면 어떤 값이든 있어야 한다. 실제로 Domain에 이 값을 채워 넣는 것은
    // 금지되어 있으므로, 이 함수는 절대 실행되지 않을 것으로 의도된 아래 한 줄에서
    // 일부러 throw해 "성공 경로가 완성되지 않았다"는 사실을 숨기지 않는다.
    cardType: unreachableCardType(),
    annualFee,
    performanceTiers: buildPerformanceTiers(normalized.performanceTiers),
    // performanceExcludedCategories: 이번 정규화 파이프라인은 이 정보를 전혀 읽지 않는다
    // (benefit_notices_json을 아직 다루지 않는다 — 이번 범위 밖). 빈 배열은 "제외 카테고리가
    // 없음이 확인됨"이 아니라 "아직 수집하지 않음"이다. 이 사실을 지우지 않기 위해
    // `NormalizedCard`의 알려진 한계로 남겨 둔다(정규화 계층에서 이 컬럼을 읽기 시작하기
    // 전까지는 이 필드를 신뢰할 수 없는 known limitation으로 취급해야 한다).
    performanceExcludedCategories: [],
    sharedCaps: [],
    spendingBenefits,
    perks,
    source,
    unverifiedConditions,
  };

  return { status: "success", card };
}

/**
 * 실제로 호출되지 않는다 — `toDomainCard()`가 `cardType`을 항상 실패 사유로 반환하기
 * 때문이다. `Card.cardType`이 필수 필드라 TypeScript가 값을 요구하므로, 값을 지어내는
 * 대신 이 지점이 도달 불가능함을 명시적으로 표시한다.
 */
function unreachableCardType(): never {
  throw new Error(
    "toDomainCard: cardType을 결정할 수 없는 카드는 success를 반환하지 않아야 한다(도달 불가능해야 하는 경로)",
  );
}
