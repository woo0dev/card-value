import type { RoundingPolicy } from "./types/calculation";
import type { BasisPoints, RewardQuantity, Won } from "./types/money";

/**
 * `Won`을 만드는 계산 산술의 단일 진입점. 반올림 정책과 안전 정수 검사를 여기에서만 다룬다.
 *
 * 정책(`floor_per_benefit`): 혜택 하나의 원화 금액을 처음 만드는 시점에 1원 단위로 한 번만 내림한다.
 * 그 뒤의 한도 적용, 합산, 연간 환산은 모두 정수 산술이다. 월 카테고리 합계 기준으로 계산하므로
 * 카드사의 건별 절사와 차이가 날 수 있다.
 *
 * 전제: 피연산자는 `validation.ts`가 이미 검증한 값이며, 이 파일은 입력을 다시 검증하지 않는다.
 * 나눗셈이 있는 연산은 피연산자가 0 이상이어야 한다 (`BigInt` 나눗셈은 0 방향으로 절사하므로
 * 0 이상일 때만 내림과 같다). 비정수 입력은 `BigInt` 변환에서 `RangeError`가 난다.
 * 결과가 안전한 정수 범위를 벗어나면 조용히 부정확해지는 대신 `RangeError`를 던진다.
 *
 * 전월실적, tier, 배타 그룹, 통합 한도, 혜택 적격성, 순위 같은 비즈니스 규칙과 `min`/`max`는
 * 이 파일의 책임이 아니다.
 */

/** 계산 결과의 `assumptions.roundingPolicy`에 기록하는 유일한 반올림 정책. */
export const ROUNDING_POLICY: RoundingPolicy = "floor_per_benefit";

const BASIS_POINTS_DENOMINATOR = BigInt(10000);
/** 요율(bps, ÷10,000)과 포인트 단가(천 포인트당 원, ÷1,000)를 함께 나누는 분모. */
const POINT_RATE_DENOMINATOR = BigInt(10000) * BigInt(1000);

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * 산술 결과를 `Won`으로 만드는 유일한 지점 (코드베이스에서 산술 결과에 대한 `as Won`은 여기뿐이다).
 * 안전한 정수가 아니면 `RangeError`를 던진다.
 */
function mintWon(value: number | bigint, operation: string): Won {
  let result: number;
  if (typeof value === "bigint") {
    if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
      throw new RangeError(`${operation}: result exceeds the safe integer range`);
    }
    result = Number(value);
  } else {
    result = value;
  }
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${operation}: result is not a safe integer`);
  }
  // `-0`이 결과로 새어 나가지 않게 한다.
  return (result + 0) as Won;
}

/**
 * 산술 결과를 `RewardQuantity`로 만드는 유일한 지점. `mintWon`과 같은 안전 정수 검사를 거친다.
 */
function mintRewardQuantity(value: number | bigint, operation: string): RewardQuantity {
  let result: number;
  if (typeof value === "bigint") {
    if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
      throw new RangeError(`${operation}: result exceeds the safe integer range`);
    }
    result = Number(value);
  } else {
    result = value;
  }
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${operation}: result is not a safe integer`);
  }
  return (result + 0) as RewardQuantity;
}

/**
 * `floor(amount × bps / 10,000)`.
 * 곱셈과 나눗셈은 `BigInt`로 정확히 계산한다. `rate`(원화) 혜택과 부가 혜택 실현 비율에 사용한다.
 */
export function applyBasisPoints(amount: Won, bps: BasisPoints): Won {
  const product = BigInt(amount) * BigInt(bps);
  return mintWon(product / BASIS_POINTS_DENOMINATOR, "applyBasisPoints");
}

/**
 * `floor(spend × rateBps × wonPerThousandPoints / 10,000,000)`.
 * 포인트를 중간에 정수화하지 않고 정확히 계산한 뒤, 최종 원화 혜택에서 한 번만 내림한다.
 */
export function applyPointRateAsWon(
  spend: Won,
  rateBps: BasisPoints,
  wonPerThousandPoints: Won,
): Won {
  const product = BigInt(spend) * BigInt(rateBps) * BigInt(wonPerThousandPoints);
  return mintWon(product / POINT_RATE_DENOMINATOR, "applyPointRateAsWon");
}

/**
 * `floor(amount / unitAmount) × quantityPerUnit`. "X원당 Y개"(`RewardUnit`) 기반 포인트/마일리지
 * 수량을 비례식 근사 없이 정확히 계산하는 유일한 지점이다. `amount`/`unitAmount`가 0 이상이므로
 * `BigInt` 나눗셈의 0 방향 절사가 내림과 같다(파일 상단 전제와 동일).
 */
export function applyUnitReward(amount: Won, unitAmount: Won, quantityPerUnit: number): RewardQuantity {
  if (!Number.isSafeInteger(quantityPerUnit)) {
    throw new RangeError("applyUnitReward: quantityPerUnit must be a safe integer");
  }
  const units = BigInt(amount) / BigInt(unitAmount);
  return mintRewardQuantity(units * BigInt(quantityPerUnit), "applyUnitReward");
}

/**
 * 정수 배수를 곱한다 (연간 환산, 방문 횟수 등). 반올림은 없다.
 * `factor`가 안전한 정수가 아니면 정확한 정수 곱이 보장되지 않으므로 `RangeError`를 던진다.
 */
export function multiplyWon(amount: Won, factor: number): Won {
  if (!Number.isSafeInteger(factor)) {
    throw new RangeError("multiplyWon: factor must be a safe integer");
  }
  return mintWon(amount * factor, "multiplyWon");
}

/** 금액을 합산한다. 빈 배열은 0이다. 누적 도중 안전한 정수 범위를 벗어나도 `RangeError`를 던진다. */
export function sumWon(amounts: readonly Won[]): Won {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError("sumWon: running total exceeds the safe integer range");
    }
  }
  return mintWon(total, "sumWon");
}

/**
 * 포인트/마일리지 수량을 합산한다. 빈 배열은 0이다(동일 프로그램의 여러 혜택을 합칠 때 사용).
 * 누적 도중 안전한 정수 범위를 벗어나도 `RangeError`를 던진다.
 */
export function sumRewardQuantity(quantities: readonly RewardQuantity[]): RewardQuantity {
  let total = 0;
  for (const quantity of quantities) {
    total += quantity;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError("sumRewardQuantity: running total exceeds the safe integer range");
    }
  }
  return mintRewardQuantity(total, "sumRewardQuantity");
}

/** `minuend - subtrahend`. 음수 결과를 허용한다 (예: 연회비를 뺀 순혜택). */
export function subtractWon(minuend: Won, subtrahend: Won): Won {
  return mintWon(minuend - subtrahend, "subtractWon");
}
