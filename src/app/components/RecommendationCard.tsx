import type { CardValueResult } from "../../lib/recommendation/types";
import type { BenefitDisplayInfo, TierDisplayInfo } from "./SpendingForm";
import BenefitCalculationDetail from "./BenefitCalculationDetail";

interface RecommendationCardProps {
  readonly rank: number;
  readonly result: CardValueResult;
  /** `route.ts`가 추가한 `cardInfo[cardId]`. 못 찾으면(있어선 안 되지만 방어적으로)
   * `cardId`를 그대로 보여준다 — 화면이 깨지지 않도록 한다. */
  readonly card?: { readonly name: string; readonly issuer: string };
  readonly benefitInfo: Readonly<Record<string, BenefitDisplayInfo>>;
  readonly tierInfo: Readonly<Record<string, TierDisplayInfo>>;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
}

export function formatWon(amount: number): string {
  return `${new Intl.NumberFormat("ko-KR").format(amount)}원`;
}

/**
 * 카드 1개의 요약 표시. 시각적 우선순위: 순위 → 카드사+카드명 → 연간 순이익(가장 크게) →
 * 연회비/월 예상 혜택/연간 혜택(보조 수치) → 경고.
 *
 * `netAnnualValue`가 음수여도 숨기거나 0으로 보정하지 않는다 — 순혜택이 음수인 것도
 * recommendation domain이 유효한 결과로 취급하는 상태다(AGENTS.md Domain Decision 13).
 * warnings는 code를 그대로 노출하지 않고 존재 여부만 사용자 친화적 문구로 보여준다
 * (사용자용 문구는 UI 계층에서 만든다 — Domain Decision 12).
 */
export default function RecommendationCard({
  rank,
  result,
  card,
  benefitInfo,
  tierInfo,
  expanded,
  onToggleExpanded,
}: RecommendationCardProps) {
  const hasWarnings = result.warnings.length > 0;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-blue-50 text-sm font-semibold text-blue-600">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-gray-500">{card?.issuer ?? "카드사 정보 없음"}</p>
          <p className="truncate text-base font-semibold text-gray-900">{card?.name ?? result.cardId}</p>
        </div>
      </div>

      <div className="mt-4">
        <p className="text-sm text-gray-500">연간 순이익</p>
        <p className="text-2xl font-bold text-blue-600">{formatWon(result.netAnnualValue)}</p>
      </div>

      <dl className="mt-4 space-y-1.5 text-sm text-gray-600">
        <div className="flex items-center justify-between">
          <dt>연회비</dt>
          <dd className="text-gray-800">{formatWon(result.annualFee)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt>월 예상 혜택</dt>
          <dd className="text-gray-800">{formatWon(result.monthlyBenefit)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt>연간 혜택</dt>
          <dd className="text-gray-800">{formatWon(result.annualBenefit)}</dd>
        </div>
      </dl>

      {hasWarnings && (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
          일부 조건 확인 필요
        </p>
      )}

      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        className="mt-4 w-full rounded-lg border border-blue-200 px-3 py-2 text-sm font-medium text-blue-600"
      >
        {expanded ? "혜택 계산 접기" : "혜택 계산 자세히 보기"}
      </button>

      {expanded && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <BenefitCalculationDetail result={result} benefitInfo={benefitInfo} tierInfo={tierInfo} />
        </div>
      )}
    </div>
  );
}
