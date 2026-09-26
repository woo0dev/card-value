import type { Won } from "./money";
import type { SpendingCategory } from "./category";

/** 카테고리별 소비액. 값이 없는 카테고리는 소비 0으로 본다. */
export type CategorySpending = Readonly<Partial<Record<SpendingCategory, Won>>>;

/**
 * 사용자의 월 소비 입력. 전월 실적 산정용 소비와 현재 월 소비를 명시적으로 분리하며,
 * 계산 엔진은 둘을 같은 값으로 간주하지 않는다.
 *
 * 입력은 카테고리별 월 합계뿐이다. 따라서 다음 카드 조건은 계산할 수 없으며 타입에도 없다.
 * 지원하려면 이 입력 모델을 먼저 확장해야 한다 (범위 밖).
 * - 건당 최소 결제 금액, 건당 한도
 * - 월/연간 결제 횟수 조건
 * - 리터당/단위당 혜택 (주유 리터 수 등)
 * - 결제수단별 조건 (간편결제, 신용/체크 등)
 * - 특정 가맹점 조건
 * - 국내/해외 구분 (`category.ts`의 `overseas` 참고)
 */
export interface MonthlySpending {
  previousMonth: CategorySpending;
  currentMonth: CategorySpending;
}
