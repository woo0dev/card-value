"use client";

import { useState, type FormEvent } from "react";
import { SPENDING_CATEGORIES } from "../../lib/recommendation/types";
import type {
  CalculationAssumptions,
  CalculationWarning,
  CategoryTarget,
  ExcludedCard,
  MonthlySpending,
  RankedCard,
  RewardCurrency,
  SpendingCategory,
} from "../../lib/recommendation/types";

/**
 * `route.ts`가 `benefitId`/`perkId` → 표시용 정보로 연결하려고 추가한 맵의 값 형태.
 * `SpendingBenefit`/`PerkBenefit` 정의 필드를 그대로 옮긴 것이며(재계산 없음),
 * "10% 할인"처럼 상세 화면에 표시하는 데 필요한 최소한만 담는다.
 */
export type BenefitDisplayInfo =
  | { kind: "rate"; name: string; target: CategoryTarget; rateBps: number; currency: RewardCurrency }
  | { kind: "fixed"; name: string; target: CategoryTarget; monthlyAmount: number }
  | { kind: "perk"; name: string };

/** `route.ts`가 `achievedTierId` → 실적 구간 이름/기준으로 연결하려고 추가한 맵의 값 형태. */
export interface TierDisplayInfo {
  readonly name: string;
  readonly minPreviousMonthSpend: number;
}

/**
 * "사용자가 실제로 확인해야 하는" warning만 caution으로 취급한다. `FIRST_YEAR_FEE_WAIVED`(단순
 * 안내)와 `PREVIOUS_MONTH_PERFORMANCE_ASSUMED`(전월 소비 미입력 시 자동으로 붙는 계산 가정
 * 안내일 뿐 미검증 조건이 아님)는 여기 포함하지 않는다. `RecommendationCard.tsx`의 목록 단계
 * "일부 조건 확인 필요" 배지와 `BenefitCalculationDetail.tsx`의 상세 caution 박스가 이 정의를
 * 그대로 공유해 기준을 하나로 유지한다(두 컴포넌트가 서로를 import하지 않도록 이 파일에 둔다).
 */
export const CAUTION_WARNING_CODES = new Set<CalculationWarning["code"]>([
  "UNVERIFIED_CONDITION",
  "POINT_VALUATION_UNVERIFIED",
]);

/**
 * `/api/recommendations`의 실제 응답 모양. `RecommendationResult`(input/ranked/excluded/
 * assumptions)에 `cardInfo`(카드 표시용 name/issuer 맵)와 `benefitInfo`/`tierInfo`(혜택 계산
 * 상세 표시용 맵, 모두 route.ts가 추가)가 더해진 형태다. recommendation domain 타입은
 * 그대로 재사용하고, 표시 전용 맵만 API 응답 전용으로 얹는다.
 */
export interface RecommendationApiResponse {
  readonly input: MonthlySpending;
  readonly ranked: readonly RankedCard[];
  readonly excluded: readonly ExcludedCard[];
  readonly assumptions: CalculationAssumptions;
  readonly cardInfo: Readonly<Record<string, { name: string; issuer: string }>>;
  readonly benefitInfo: Readonly<Record<string, BenefitDisplayInfo>>;
  readonly tierInfo: Readonly<Record<string, TierDisplayInfo>>;
}

export const CATEGORY_LABELS: Record<SpendingCategory, string> = {
  dining: "외식",
  cafe: "카페",
  convenience_store: "편의점",
  grocery: "마트/식료품",
  online_shopping: "온라인쇼핑",
  offline_shopping: "오프라인쇼핑",
  public_transport: "대중교통",
  taxi: "택시",
  fuel: "주유",
  telecom: "통신",
  utilities: "공과금",
  medical: "병원/약국",
  education: "교육",
  entertainment: "문화/오락",
  subscription: "구독서비스",
  travel: "여행/항공",
  overseas: "해외결제",
  insurance: "보험",
  tax: "세금",
  gift_card: "상품권",
  other: "기타",
};

/**
 * API가 요구하는 `CalculationAssumptions` 3개 필드. 사용자에게 입력받지 않는다 — 읽기
 * 전용 분석에서 확인한 근거만 쓰고, 새로 지어내지 않는다.
 * - `roundingPolicy`: 타입상 `"floor_per_benefit"` 하나뿐이라 이 값만 쓸 수 있다.
 * - `annualizationMonths`: 코드 실행 상수는 없지만 `types/calculation.ts`의 doc comment와
 *   AGENTS.md Domain Decision 7("monthlyBenefit * 12로 연간 가치를 환산한다")이 12를
 *   문서로 명시한다.
 * - `perkValuation`: 코드/AGENTS.md 어디에도 기본값 근거가 없다(`recommendation/index.ts`
 *   자체 주석이 이를 명시). 현재 DB에 perk 데이터가 0건이라 "실현 비율을 사용자가 선택"할
 *   대상 자체가 없고, 그 값을 실현시키려면 사용자 입력(perk별 realizationBps)이 필요한데
 *   그 UI 계약이 아직 없다. `"exclude_perks"`는 100% 가치가 실현된다고 임의로 가정하지
 *   않는다는 AGENTS.md 부가혜택 원칙과도 맞는 보수적 선택이라 이 값을 쓴다.
 */
const ASSUMPTIONS: CalculationAssumptions = {
  roundingPolicy: "floor_per_benefit",
  annualizationMonths: 12,
  perkValuation: "exclude_perks",
};

type CategoryAmounts = Partial<Record<SpendingCategory, string>>;
type SubmitStatus = "idle" | "loading" | "success" | "error";

interface SpendingFormProps {
  readonly onResult: (result: RecommendationApiResponse) => void;
  readonly onError: (message: string) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 입력된 문자열 금액을 정수 KRW로 변환한다. 비어 있는 카테고리는 생략한다(0으로 명시
 * 저장하지 않음 — `CategorySpending`이 이미 `Partial`이라 없는 카테고리 = 0으로 해석됨). */
function buildSpendingSection(amounts: CategoryAmounts): {
  spending: Partial<Record<SpendingCategory, number>>;
  hasNegative: boolean;
} {
  const spending: Partial<Record<SpendingCategory, number>> = {};
  let hasNegative = false;
  for (const category of SPENDING_CATEGORIES) {
    const raw = amounts[category];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (value < 0) {
      hasNegative = true;
      continue;
    }
    spending[category] = Math.trunc(value);
  }
  return { spending, hasNegative };
}

/** 기존 `ValidationErrorCode` 중 이 폼의 입력에서 실제로 나올 수 있는 몇 가지만 최소
 * 한국어 문구로 매핑한다 — 모든 code를 장황하게 지원하지 않는다. */
function describeValidationErrorCode(code: string): string | null {
  switch (code) {
    case "NEGATIVE_VALUE":
      return "음수 금액은 입력할 수 없습니다.";
    case "NOT_SAFE_INTEGER":
    case "NOT_FINITE":
      return "숫자만 입력해주세요.";
    case "MISSING_FIELD":
      return "입력값이 비어 있어요.";
    default:
      return null;
  }
}

function describeErrorResponse(status: number, data: unknown): string {
  if (status === 400 && isPlainObject(data) && Array.isArray(data.errors)) {
    const first = (data.errors as readonly unknown[])[0];
    const code = isPlainObject(first) && typeof first.code === "string" ? first.code : null;
    const detail = code ? describeValidationErrorCode(code) : null;
    return detail ? `입력값을 확인해주세요. ${detail}` : "입력값을 확인해주세요.";
  }
  return "추천 결과를 불러오지 못했어요. 잠시 후 다시 시도해주세요.";
}

interface SpendingSectionProps {
  readonly idPrefix: string;
  readonly title: string;
  readonly description: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly amounts: CategoryAmounts;
  readonly onChange: (category: SpendingCategory, value: string) => void;
}

/** 지난달/이번 달 소비 입력 영역 하나(접기/펼치기 + 카테고리 21개). 별도 파일로 빼지 않고
 * 이 파일 안에서만 재사용한다(지시사항: CategoryAmountInput을 별도 파일로 만들지 않음). */
function SpendingSection({
  idPrefix,
  title,
  description,
  expanded,
  onToggle,
  amounts,
  onChange,
}: SpendingSectionProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left"
      >
        <span>
          <span className="block text-base font-semibold text-gray-900">{title}</span>
          <span className="block text-sm text-gray-500">{description}</span>
        </span>
        <span className="flex-none text-sm font-medium text-blue-600">{expanded ? "접기" : "펼치기"}</span>
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-gray-100 px-4 py-4">
          {SPENDING_CATEGORIES.map((category) => {
            const inputId = `${idPrefix}-${category}`;
            return (
              <div key={category} className="flex items-center justify-between gap-3">
                <label htmlFor={inputId} className="text-sm text-gray-700">
                  {CATEGORY_LABELS[category]}
                </label>
                <div className="flex flex-none items-center gap-1.5">
                  <input
                    id={inputId}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    placeholder="0"
                    value={amounts[category] ?? ""}
                    onChange={(event) => onChange(category, event.target.value)}
                    className="w-28 rounded-lg border border-gray-300 px-2 py-1.5 text-right text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
                  />
                  <span className="text-sm text-gray-500">원</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function SpendingForm({ onResult, onError }: SpendingFormProps) {
  const [previousAmounts, setPreviousAmounts] = useState<CategoryAmounts>({});
  const [currentAmounts, setCurrentAmounts] = useState<CategoryAmounts>({});
  const [previousExpanded, setPreviousExpanded] = useState(false);
  const [currentExpanded, setCurrentExpanded] = useState(false);
  const [status, setStatus] = useState<SubmitStatus>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const previous = buildSpendingSection(previousAmounts);
    const current = buildSpendingSection(currentAmounts);

    if (previous.hasNegative || current.hasNegative) {
      setStatus("error");
      onError("입력값을 확인해주세요. 음수 금액은 입력할 수 없습니다.");
      return;
    }

    setStatus("loading");

    // 지난달 소비에 채워진 카테고리가 하나도 없으면(펼치지 않았거나, 펼쳤어도 전부 빈 값)
    // "미입력"으로 보고 previousMonth를 null로 보낸다 — 전월실적 조건을 충족한 것으로
    // 가정해달라는 신호다(recommendation/types/spending.ts 참고). 사용자가 카테고리 중
    // 하나라도 실제로 값을 입력했다면(0원 입력 포함) previous.spending 객체를 그대로
    // 보낸다 — "0원으로 입력함"과 "미입력"은 서로 다른 상태이므로 여기서 임의로 합치지 않는다.
    const previousMonth = Object.keys(previous.spending).length === 0 ? null : previous.spending;

    try {
      const response = await fetch("/api/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spending: { previousMonth, currentMonth: current.spending },
          assumptions: ASSUMPTIONS,
        }),
      });
      const data: unknown = await response.json().catch(() => null);

      if (response.ok && data !== null) {
        setStatus("success");
        onResult(data as RecommendationApiResponse);
        return;
      }

      setStatus("error");
      onError(describeErrorResponse(response.status, data));
    } catch {
      setStatus("error");
      onError("추천 결과를 불러오지 못했어요. 잠시 후 다시 시도해주세요.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <SpendingSection
        idPrefix="previous"
        title="지난달 소비"
        description="지난달 실제 카드 사용 금액"
        expanded={previousExpanded}
        onToggle={() => setPreviousExpanded((value) => !value)}
        amounts={previousAmounts}
        onChange={(category, value) => setPreviousAmounts((prev) => ({ ...prev, [category]: value }))}
      />
      <SpendingSection
        idPrefix="current"
        title="이번 달 예상 소비"
        description="이번 달 예상 카드 사용 금액"
        expanded={currentExpanded}
        onToggle={() => setCurrentExpanded((value) => !value)}
        amounts={currentAmounts}
        onChange={(category, value) => setCurrentAmounts((prev) => ({ ...prev, [category]: value }))}
      />

      <button
        type="submit"
        disabled={status === "loading"}
        className="w-full rounded-xl bg-blue-600 px-4 py-3.5 text-base font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:bg-blue-300"
      >
        {status === "loading" ? "카드를 비교하고 있어요..." : "카드 추천받기"}
      </button>
    </form>
  );
}
