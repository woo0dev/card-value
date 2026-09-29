import type {
  BenefitCalculation,
  CalculationStep,
  CardValueResult,
  CategoryTarget,
  NotAppliedReason,
  PerkCalculation,
} from "../../lib/recommendation/types";
import { CATEGORY_LABELS, CAUTION_WARNING_CODES, type BenefitDisplayInfo, type TierDisplayInfo } from "./SpendingForm";
import { formatWon } from "./RecommendationCard";

interface BenefitCalculationDetailProps {
  readonly result: CardValueResult;
  readonly benefitInfo: Readonly<Record<string, BenefitDisplayInfo>>;
  readonly tierInfo: Readonly<Record<string, TierDisplayInfo>>;
}

function describeTarget(target: CategoryTarget): string {
  if (target.type === "categories") {
    return target.categories.map((category) => CATEGORY_LABELS[category]).join(", ");
  }
  if (target.categories.length === 0) return "전체 이용 금액";
  return `전체 이용 금액 (${target.categories.map((category) => CATEGORY_LABELS[category]).join(", ")} 제외)`;
}

/** `BenefitDisplayInfo`(실제 혜택 정의)를 "10% 할인"/"매월 5,000원 고정 혜택" 같은
 * 한 줄 요약으로 바꾼다. 값은 모두 실제 필드에서 그대로 가져오며(rateBps → %는 단위
 * 표기 변환일 뿐 새 계산이 아니다), 계산을 다시 하지 않는다. */
function describeBenefitHeadline(info: BenefitDisplayInfo | undefined): string | null {
  if (!info) return null;
  if (info.kind === "fixed") return `매월 ${formatWon(info.monthlyAmount)} 고정 혜택`;
  if (info.kind === "rate") {
    const percent = info.rateBps / 100;
    const percentText = Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(2)}%`;
    if (info.currency.type === "points") return `${percentText} 적립 (${info.currency.programName})`;
    return info.currency.form === "discount" ? `${percentText} 할인` : `${percentText} 캐시백`;
  }
  return null;
}

/** 한도(cap)가 실제로 값을 바꿨을 때만 기록되는 step이므로, 있으면 그대로 "before → after"로
 * 보여준다. 새 숫자를 계산하지 않고 step에 실제로 들어있는 값만 옮긴다. */
function describeProgressStep(step: CalculationStep): string | null {
  switch (step.code) {
    case "ELIGIBLE_SPEND_CAPPED":
      return `대상 사용액 한도 ${formatWon(step.cap)} 적용 (${formatWon(step.before)} → ${formatWon(step.after)})`;
    case "BENEFIT_CAP_APPLIED":
      return `월 혜택 한도 ${formatWon(step.cap)} 적용 (${formatWon(step.before)} → ${formatWon(step.after)})`;
    case "SHARED_CAP_APPLIED":
      return `여러 혜택이 함께 쓰는 통합 한도 ${formatWon(step.cap)} 적용 (${formatWon(step.before)} → ${formatWon(step.after)})`;
    default:
      return null;
  }
}

function describeNotAppliedReason(
  reason: NotAppliedReason,
  tierInfo: Readonly<Record<string, TierDisplayInfo>>,
): string {
  switch (reason.code) {
    case "TIER_NOT_MET": {
      const requiredTier = tierInfo[reason.requiredTierId];
      return requiredTier
        ? `전월실적이 부족해 적용되지 않았습니다 (필요 구간: ${requiredTier.name}).`
        : "전월실적이 부족해 적용되지 않았습니다.";
    }
    case "NO_ELIGIBLE_SPEND":
      return "해당 카테고리에 이번 달 소비 입력이 없어 적용되지 않았습니다.";
    case "MIN_MONTHLY_SPEND_NOT_MET":
      return `최소 이용 금액(${formatWon(reason.required)}) 조건을 채우지 못해 적용되지 않았습니다.`;
    case "SUPERSEDED_IN_EXCLUSIVE_GROUP":
      return "같은 그룹의 다른 혜택이 먼저 적용되어 이 혜택은 적용되지 않았습니다.";
    case "SHARED_CAP_EXHAUSTED":
      return "다른 혜택이 통합 한도를 모두 사용해 적용되지 않았습니다.";
  }
}

/** `REWARD_COMPUTED` 계산에 실제로 쓰인 대상 사용액. `ELIGIBLE_SPEND_CAPPED`가 있었다면
 * 그 한도 적용 후 값이고, 없었다면 `eligibleSpend` 그대로다 — 어느 쪽이든 실제 step에
 * 이미 들어있는 값을 고르는 것뿐, 새로 계산하지 않는다. */
function resolveSpendUsedForReward(calc: BenefitCalculation): number {
  const capped = calc.steps.find((step) => step.code === "ELIGIBLE_SPEND_CAPPED");
  return capped && capped.code === "ELIGIBLE_SPEND_CAPPED" ? capped.after : calc.eligibleSpend;
}

function AppliedBenefitItem({
  calc,
  info,
}: {
  calc: Extract<BenefitCalculation, { status: "applied" }>;
  info: BenefitDisplayInfo | undefined;
}) {
  const headline = describeBenefitHeadline(info);
  const progressLines = calc.steps.map(describeProgressStep).filter((line): line is string => line !== null);
  const spendUsedForReward = resolveSpendUsedForReward(calc);
  // `REWARD_COMPUTED.rawAmount`를 어떻게 얻었는지 보여주는 첫 줄. `eligibleSpend`(또는 한도
  // 적용 후 값)와 `rateBps`는 모두 실제 필드값이고, 여기서 새로 곱셈/나눗셈을 하지 않는다 —
  // 이미 계산된 `rawAmount`를 그대로 이어붙여 보여줄 뿐이다. `fixed` 혜택은 사용액에
  // 의존하지 않으므로(rewards.ts) 다른 문구를 쓴다.
  const formulaLine =
    info?.kind === "fixed"
      ? `매월 고정 혜택 = ${formatWon(calc.rawAmount)}`
      : `${formatWon(spendUsedForReward)} × ${headline ?? "혜택"} = ${formatWon(calc.rawAmount)}`;

  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
      <p className="text-sm font-semibold text-gray-900">{info?.name ?? calc.benefitId}</p>
      {info && info.kind !== "perk" && <p className="text-xs text-gray-500">{describeTarget(info.target)}</p>}
      {headline && <p className="mt-1 text-sm font-medium text-blue-600">{headline}</p>}

      <dl className="mt-3 space-y-1 text-sm text-gray-600">
        <div className="flex items-center justify-between">
          <dt>이번 달 대상 사용액</dt>
          <dd className="text-gray-800">{formatWon(spendUsedForReward)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt>예상 혜택</dt>
          <dd className="font-semibold text-gray-900">{formatWon(calc.finalAmount)}</dd>
        </div>
      </dl>

      <div className="mt-3 space-y-1 border-t border-gray-200 pt-2 text-xs text-gray-500">
        <p className="font-medium text-gray-600">계산 과정</p>
        <p>{formulaLine}</p>
        {progressLines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
    </div>
  );
}

function PerkItem({ calc, info }: { calc: PerkCalculation; info: BenefitDisplayInfo | undefined }) {
  const recurrenceLabel = calc.recurrence === "recurring" ? "매년 반복" : "최초 1회";
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
      <p className="text-sm font-semibold text-gray-900">{info?.name ?? calc.perkId}</p>
      <p className="text-xs text-gray-500">{recurrenceLabel}</p>
      <dl className="mt-3 space-y-1 text-sm text-gray-600">
        <div className="flex items-center justify-between">
          <dt>표시 가치</dt>
          <dd className="text-gray-800">{formatWon(calc.nominalValue)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt>현재 반영된 가치</dt>
          <dd className="font-semibold text-gray-900">{formatWon(calc.realizedValue)}</dd>
        </div>
      </dl>
    </div>
  );
}

function describeCautionWarning(): string {
  return "일부 카드 혜택 조건은 추가 확인이 필요합니다. 최종 이용 전 카드사 홈페이지에서 조건을 확인해주세요.";
}

function describeFeeNoteWarning(): string {
  return "이 카드는 첫 해 연회비가 면제될 수 있어요. 위 금액은 연회비가 매년 전액 부과된다고 가정한 반복 기준이라, 첫 해 실제 순혜택은 이보다 클 수 있습니다.";
}

/**
 * 선택된 카드 1장의 계산 상세. `CardValueResult`(+ `benefitInfo`/`tierInfo` 표시용 맵)에
 * 이미 있는 값만 그대로 보여준다 — 이 컴포넌트는 presentation layer이고, 금액이나 혜택을
 * 새로 계산하지 않는다.
 */
export default function BenefitCalculationDetail({ result, benefitInfo, tierInfo }: BenefitCalculationDetailProps) {
  const applied = result.benefitCalculations.filter(
    (calc): calc is Extract<BenefitCalculation, { status: "applied" }> => calc.status === "applied",
  );
  const notApplied = result.benefitCalculations.filter(
    (calc): calc is Extract<BenefitCalculation, { status: "not_applied" }> => calc.status === "not_applied",
  );

  const achievedTier = result.achievedTierId ? tierInfo[result.achievedTierId] : null;

  const hasCaution = result.warnings.some((warning) => CAUTION_WARNING_CODES.has(warning.code));
  const hasFeeNote = result.warnings.some((warning) => warning.code === "FIRST_YEAR_FEE_WAIVED");
  const hasAssumedPerformance = result.warnings.some(
    (warning) => warning.code === "PREVIOUS_MONTH_PERFORMANCE_ASSUMED",
  );

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-sm font-semibold text-gray-900">전월실적</h3>
        {hasAssumedPerformance ? (
          // `achievedTierId`는 실제로는 카드의 최고 구간을 가정한 값이다(eligibility.ts) — 이를
          // "실제 지난달 사용액"/"실제 달성한 구간"처럼 보여주면 사실과 다르게 보일 수 있어
          // 그 대신 가정했다는 사실 자체를 명확히 알린다.
          <p className="mt-1 text-sm text-gray-600">
            전월 소비를 입력하지 않아 전월실적 조건을 충족한 것으로 가정하고 계산했어요.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-gray-600">지난달 사용액 {formatWon(result.previousMonthPerformance)}</p>
            <p className="text-sm text-gray-600">
              {result.achievedTierId === null
                ? "적용되는 실적 구간이 없습니다."
                : achievedTier
                  ? `적용 구간 ${achievedTier.name}`
                  : "적용 혜택 구간이 계산에 반영되었습니다."}
            </p>
          </>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-gray-900">혜택 계산</h3>
        {applied.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">이번 달 소비 입력으로 적용된 혜택이 없습니다.</p>
        ) : (
          <div className="mt-2 space-y-3">
            {applied.map((calc) => (
              <AppliedBenefitItem key={calc.benefitId} calc={calc} info={benefitInfo[calc.benefitId]} />
            ))}
          </div>
        )}
        {notApplied.length > 0 && (
          <details className="mt-3 text-xs text-gray-500">
            <summary className="cursor-pointer select-none">적용되지 않은 혜택 {notApplied.length}개</summary>
            <div className="mt-2 space-y-1.5">
              {notApplied.map((calc) => (
                <p key={calc.benefitId}>
                  <span className="font-medium text-gray-600">{benefitInfo[calc.benefitId]?.name ?? calc.benefitId}</span>
                  {" — "}
                  {describeNotAppliedReason(calc.reason, tierInfo)}
                </p>
              ))}
            </div>
          </details>
        )}
      </section>

      {result.perkCalculations.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-gray-900">부가 혜택</h3>
          <div className="mt-2 space-y-3">
            {result.perkCalculations.map((calc) => (
              <PerkItem key={calc.perkId} calc={calc} info={benefitInfo[calc.perkId]} />
            ))}
          </div>
        </section>
      )}

      {(hasCaution || hasFeeNote) && (
        <section className="space-y-2">
          {hasCaution && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
              ⚠️ 확인이 필요한 조건
              <br />
              {describeCautionWarning()}
            </p>
          )}
          {hasFeeNote && (
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700">{describeFeeNoteWarning()}</p>
          )}
        </section>
      )}
    </div>
  );
}
