import type {
  NormalizationOutcome,
  NormalizedBenefitPiece,
  NormalizedCard,
  NormalizedPerformanceTier,
  NormalizedPerkPiece,
  NormalizedSpendingBenefitPiece,
} from "./normalizeTypes";
import { findUnsupportedCode, isPieceFullyParsed } from "./normalizeCard";
import { createDuplicateGroupId, createExclusiveGroupId } from "./id";
import type {
  BenefitId,
  Card,
  CardId,
  CardSource,
  CoreConditionField,
  ExclusiveGroupId,
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
 * `priority`/`exclusiveGroupId`는 원문에서 파싱되는 값이 아니다. `priority`는 항상
 * `0`이다(§`buildSpendingBenefit` 참고 — eligibility.ts의 배타 그룹 승자 결정은 tier
 * rank를 먼저 비교하므로 이걸로 충분하다). `exclusiveGroupId`는 두 단계로 결정된다:
 *
 * 1) 같은 raw row(`benefit.pieces`)에서 fully-parsed spendingBenefit piece가 2개 이상
 *    나오면(구간별 분해, D) 그 piece들에 같은 `exclusiveGroupId`
 *    (`createExclusiveGroupId(cardAdId, sourceBenefitOrder)`)를 부여해 서로 배타 경쟁하게
 *    하고, 1개뿐이면 `null`이다.
 * 2) 1)에서 `null`로 남은(= 같은 row 그룹에 속하지 않은) `SpendingBenefit`들 중, 서로 다른
 *    row에서 나왔는데도 `target`/`reward`/`limits`/`requiredTierId`/`minMonthlySpend`가
 *    전부 동일한 것들이 있으면(§`mergeDuplicateLogicalBenefits` 참고 — 카드 원본 데이터가
 *    같은 혜택을 카테고리 태그별로 중복 등록한 경우) 그것들도 새 `exclusiveGroupId`
 *    (`createDuplicateGroupId`)로 묶는다. 1)의 same-row 그룹과는 별개의 id 공간이며 절대
 *    섞이지 않는다 — 1)에서 이미 그룹이 부여된 benefit은 2)의 후보에서 제외된다.
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
 *
 * `cardType`은 실패 사유가 아니다. 현재 CSV에는 credit/check를 판단할 컬럼이 전혀 없지만,
 * Domain `CardType`이 `"unknown"` 상태를 표현할 수 있으므로(`types/card.ts` 참고) 판별
 * 근거가 없다는 사실 자체를 `cardType: "unknown"`으로 그대로 옮기고 `Card` 생성은 막지 않는다.
 */
export type ToDomainCardFailureReason =
  | { readonly code: "ANNUAL_FEE_UNVERIFIED" }
  | { readonly code: "SOURCE_URL_MISSING" };

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

function asExclusiveGroupId(value: string): ExclusiveGroupId {
  return value as ExclusiveGroupId;
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

function buildSpendingBenefit(
  piece: NormalizedSpendingBenefitPiece,
  exclusiveGroupId: ExclusiveGroupId | null,
): SpendingBenefit {
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
    // priority는 tier별로 계산하지 않는다 — eligibility.ts의 배타 그룹 승자 결정은
    // requiredTierId가 가리키는 tier rank를 먼저 비교하고, priority는 tier rank가 완전히
    // 같을 때만 참고하는 tie-breaker다. 다구간 분해로 생성되는 benefit들은 서로 다른
    // threshold(= 다른 tier rank)를 갖는 것이 전제이므로 이 값으로 충분하다.
    priority: 0,
    requiredTierId,
    target,
    minMonthlySpend,
    limits,
    sharedCapId,
    exclusiveGroupId,
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
// Cross-row duplicate(logical benefit) 병합
// ---------------------------------------------------------------------------

/**
 * 서로 다른 raw row에서 나온 두 `SpendingBenefit`이 의미상 완전히 같은 혜택인지 판정하는
 * key. `target`/`reward`(`kind` 포함)/`limits`/`requiredTierId`/`minMonthlySpend` 다섯
 * 필드가 전부 같을 때만 같은 key를 갖는다. `id`/`name`/`priority`/`sharedCapId`/
 * `exclusiveGroupId`는 의도적으로 제외한다 — dedupe 기준으로 합의된 필드가 아니다.
 * `target.categories`는 원문 배열의 순서에 의미가 없으므로 정렬 후 비교한다.
 */
function duplicateSemanticKey(benefit: SpendingBenefit): string {
  const target = {
    type: benefit.target.type,
    categories: [...benefit.target.categories].sort(),
  };
  const reward =
    benefit.kind === "rate"
      ? { kind: "rate" as const, rateBps: benefit.rateBps, currency: benefit.currency }
      : { kind: "fixed" as const, monthlyAmount: benefit.monthlyAmount };
  return JSON.stringify({
    target,
    reward,
    limits: benefit.limits,
    requiredTierId: benefit.requiredTierId,
    minMonthlySpend: benefit.minMonthlySpend,
  });
}

/**
 * 서로 다른 raw row(다른 `sourceBenefitOrder`)에서 나왔지만 의미상 완전히 동일한
 * `SpendingBenefit`이 카드 내에 여럿 있으면(예: 같은 혜택이 카테고리 브라우징 탭마다
 * 반복 등록된 raw 데이터) 같은 `exclusiveGroupId`로 묶는다 — 계산은 바꾸지 않는다.
 * eligibility.ts의 기존 배타 그룹 승자 선택(`requiredTierId` rank → `priority` → `id`
 * 오름차순)이 그대로 작동해, 동일한 tier/priority를 가진 중복 후보 중 정확히 하나만
 * 남기고 나머지는 `SUPERSEDED_IN_EXCLUSIVE_GROUP`으로 처리된다.
 *
 * `validateCard()`의 `EXCLUSIVE_GROUP_AMBIGUOUS_ORDER` 경고는 이 그룹에서도 그대로
 * 발생한다(의도적으로 억제하지 않는다) — 이 dedupe로 묶인 후보는 정의상 `requiredTierId`와
 * `priority`가 항상 동일하므로 매번 이 경고 조건에 해당하는데, 그 경고의 원래 의미
 * ("우선순위를 구분할 신호가 없어 id로 tie-break했다")가 이 상황에도 문자 그대로
 * 참이기 때문이다 — 새 warning 종류를 만들지 않고 기존 경고를 그대로 재사용한다.
 *

 * - `exclusiveGroupId !== null`인 benefit(같은 row의 tier 분해, D)은 후보에서 제외한다 —
 *   기존 same-row 그룹과 절대 섞이지 않는다. 같은 row에서 fully-parsed piece가 2개
 *   이상이면 항상 같은 `exclusiveGroupId`를 이미 받으므로, `exclusiveGroupId === null`인
 *   후보는 구조적으로 항상 서로 다른 row에서 나온 것이다 — 별도로 `sourceBenefitOrder`를
 *   비교할 필요가 없다.
 * - key가 같은 후보가 2개 이상일 때만 새 `exclusiveGroupId`를 부여한다. 1개뿐이면
 *   경쟁 상대가 없으므로 `null`을 그대로 유지한다.
 * - target/reward/limits/requiredTierId/minMonthlySpend 중 하나라도 다르면 다른 key이므로
 *   묶이지 않는다 — 같은 원문이라도 실제로 서로 다른 카테고리/요율을 가리키는 benefit
 *   (예: 하나의 "통합" 문구가 `cafe`/`convenience_store`/`medical`처럼 서로 다른
 *   카테고리에 반복 적용되는 경우, 또는 reward 수치 자체가 다른 경우)은 이 조건에서
 *   자동으로 걸러져 별개의 benefit으로 남는다.
 */
function mergeDuplicateLogicalBenefits(
  cardAdId: string,
  spendingBenefits: readonly SpendingBenefit[],
): readonly SpendingBenefit[] {
  const candidateGroups = new Map<string, SpendingBenefit[]>();
  for (const benefit of spendingBenefits) {
    if (benefit.exclusiveGroupId !== null) continue;
    const key = duplicateSemanticKey(benefit);
    const members = candidateGroups.get(key) ?? [];
    members.push(benefit);
    candidateGroups.set(key, members);
  }

  const newGroupIdByBenefitId = new Map<BenefitId, ExclusiveGroupId>();
  let groupIndex = 0;
  for (const members of candidateGroups.values()) {
    if (members.length < 2) continue;
    const groupId = asExclusiveGroupId(createDuplicateGroupId(cardAdId, groupIndex));
    groupIndex++;
    for (const member of members) newGroupIdByBenefitId.set(member.id, groupId);
  }

  if (newGroupIdByBenefitId.size === 0) return spendingBenefits;

  return spendingBenefits.map((benefit) => {
    const groupId = newGroupIdByBenefitId.get(benefit.id);
    return groupId === undefined ? benefit : { ...benefit, exclusiveGroupId: groupId };
  });
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
 * - `annualFee`가 `parsed`가 아니거나 `sourceUrl`이 `null`이면 `Card`를 만들지 않고 `failed`를
 *   반환한다. `cardType`은 판별 근거가 없어도 `Card` 생성을 막지 않는다 — `"unknown"`으로
 *   명시적으로 남긴다(`ToDomainCardFailureReason` 문서 참고). 어떤 필드도 임의 값으로
 *   채우지 않는다.
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
  // 임의 기본값(예: "credit")을 넣지 않고, 판별 근거가 없다는 사실 자체를 아래
  // `cardType: "unknown"`으로 명시적으로 옮긴다 — 이 사실은 Card 생성을 막을 이유가
  // 아니므로 failure reason에는 추가하지 않는다.

  if (reasons.length > 0) {
    return {
      status: "failed",
      reasons: reasons as unknown as readonly [ToDomainCardFailureReason, ...ToDomainCardFailureReason[]],
    };
  }

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
    // 이 row(`benefit`)에서 나온 fully-parsed spendingBenefit piece가 2개 이상이면(구간별
    // 분해, D) 그 piece들만 같은 exclusiveGroupId로 묶는다. perk piece는 세지 않는다 —
    // exclusiveGroupId는 `SpendingBenefit`에만 있는 필드다. 1개뿐이면(분해 없음) 지금까지와
    // 동일하게 `null`이다.
    const fullyParsedSpendingBenefitCount = benefit.pieces.filter(
      (p) => p.kind === "spendingBenefit" && isPieceFullyParsed(p),
    ).length;
    const exclusiveGroupId =
      fullyParsedSpendingBenefitCount >= 2
        ? asExclusiveGroupId(createExclusiveGroupId(cardIdentity.cardAdId, benefit.sourceBenefitOrder))
        : null;

    for (const piece of benefit.pieces) {
      if (isPieceFullyParsed(piece)) {
        if (piece.kind === "spendingBenefit") spendingBenefits.push(buildSpendingBenefit(piece, exclusiveGroupId));
        else perks.push(buildPerk(piece));
        continue;
      }
      if (findUnsupportedCode(piece) !== null) {
        // unsupported: Domain에 반영하지 않는다. 원본 provenance는 NormalizedCard 쪽에
        // 이미 남아 있으므로 여기서 추가로 기록하지 않는다.
        continue;
      }
      // 이 piece는 fully parsed가 아니라서 spendingBenefits/perks에 들어가지 않았다 —
      // 즉 piece.benefitId는 Domain에 존재하지 않는 id다. 존재하지 않는 benefit을
      // 가리키는 참조를 만들지 않기 위해 benefitId를 null로 남긴다(`UnverifiedCondition`
      // 문서 참고 — non-null은 실제 spendingBenefits/perks에 있는 benefit만 가리킨다).
      for (const field of collectUnverifiedCoreFields(piece)) {
        unverifiedConditions.push({ field, benefitId: null });
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
    // 현재 CSV/NormalizedCard 어디에도 credit/check를 판단할 근거가 없다. 추정하지
    // 않고, 판별 근거가 없다는 사실 그대로 "unknown"을 쓴다(`types/card.ts`의
    // `CardType` 문서 참고 — 임의의 기본값이 아니라 명시적인 "모름" 상태다).
    cardType: "unknown",
    annualFee,
    performanceTiers: buildPerformanceTiers(normalized.performanceTiers),
    // performanceExcludedCategories: 이번 정규화 파이프라인은 이 정보를 전혀 읽지 않는다
    // (benefit_notices_json을 아직 다루지 않는다 — 이번 범위 밖). 빈 배열은 "제외 카테고리가
    // 없음이 확인됨"이 아니라 "아직 수집하지 않음"이다. 이 사실을 지우지 않기 위해
    // `NormalizedCard`의 알려진 한계로 남겨 둔다(정규화 계층에서 이 컬럼을 읽기 시작하기
    // 전까지는 이 필드를 신뢰할 수 없는 known limitation으로 취급해야 한다).
    performanceExcludedCategories: [],
    sharedCaps: [],
    spendingBenefits: mergeDuplicateLogicalBenefits(cardIdentity.cardAdId, spendingBenefits),
    perks,
    source,
    unverifiedConditions,
  };

  return { status: "success", card };
}
