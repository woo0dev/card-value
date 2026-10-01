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
import type { BasisPoints, CategoryTarget, RewardCurrency, SpendingCategory, Won } from "../recommendation/types";

/**
 * `card_ad_id=1294`(KB국민 굿데이올림카드) 하나를 대상으로 실제로 동작하는 최소
 * normalization pipeline. 443장 전체를 지원하는 것이 목표가 아니다 — 이 카드의 실제
 * benefit 텍스트에서 확인되는, 아래 "지원 범위"에 해당하는 패턴만 처리하고, 그 밖의
 * 모든 것(건당 조건, 횟수 제한, 특정 가맹점, 국내/해외 조합, 신규회원 이벤트, 리터당 단위
 * 적립, 복잡한 tiered rate, shared cap 자동 추론 등)은 `unsupported`/`unverified`로
 * 남기며 절대 추측해서 채우지 않는다. 예외적으로 "N원당 M마일/포인트" 엄격 패턴(포인트/
 * 마일리지, `detectUnitBasedPointsOrMiles` 참고)만 원화 환산 없이 좁게 지원한다 — 브랜드가
 * 수량보다 먼저 오는 어순, 소수 수량, "최대" 수식어, 한 row에 여러 rate가 섞인 경우,
 * programName을 특정할 수 없는 경우는 여전히 `unverified`로 남긴다.
 *
 * `benefit_values_json`은 쓰지 않는다 — 배열 길이가 실적 구간 수와 무관함이 이미
 * 실측으로 확인되었다(예: 구간 2개인데 원소 10개). 실제 조건은 `benefit_descriptions_json`
 * (문단 배열의 배열)과 `benefit_summary`에서만 읽는다.
 */

/**
 * 실제 `card_value_benefits.csv`의 `benefit_category` 값(전수 조사 결과 서로 다른 값 40개)
 * 중, 하나의 `SpendingCategory`로 명확하게 대응되는 라벨만 담는다. 이 목록에 없는 라벨은
 * (매핑표가 부족해서든, 애초에 여러 카테고리로 해석될 수 있어서든) `detectTarget()` 아래
 * 분기에서 `AMBIGUOUS_TARGET_CATEGORY`로 남는다 — 억지로 끼워 맞추지 않는다.
 *
 * 넣지 않은 것들(예시, 이유):
 * - "쇼핑": online/offline_shopping 중 어느 쪽인지 라벨만으로 알 수 없음.
 * - "관리비"/"공과금": utilities/tax 등 여러 카테고리로 해석될 수 있음(다른 benefit 원문에서
 *   "공과금"이 국세/지방세까지 포함하는 것으로 쓰이는 사례를 실제로 확인함).
 * - "레저"/"뷰티"/"오토"/"육아"/"반려동물"/"금융"/"법인"/"사업자"/"하이패스"/"생활" 등:
 *   `SpendingCategory`(21종) 중 하나로 단정할 근거가 부족함.
 * - "포인트/캐시백"/"연회비지원"/"프리미엄"/"바우처"/"간편결제"/"국민행복카드"/"그린카드"/
 *   "체크카드겸용"/"Priority Pass"/"경차유류환급"/"수수료 우대"/"납부 혜택": 소비 카테고리가
 *   아니라 보상 방식/카드 등급/부가혜택/결제수단/프로그램명을 나타내는 라벨이라 애초에
 *   대상이 아님.
 */
const CATEGORY_BY_RAW_LABEL: ReadonlyMap<string, SpendingCategory> = new Map([
  ["주유", "fuel"],
  ["통신", "telecom"],
  ["카페/베이커리", "cafe"],
  ["편의점", "convenience_store"],
  ["의료", "medical"],
  // 아래는 이번 확장에서 추가. 전부 라벨이 가리키는 대상이 하나의 SpendingCategory로만
  // 해석되는 경우만 담았다(실제 CSV 값 기준, 임의 추정 아님).
  ["외식", "dining"],
  ["대중교통", "public_transport"],
  ["교육", "education"],
  ["영화", "entertainment"],
  ["문화", "entertainment"],
  ["항공마일리지", "travel"],
  // "대형마트"(이마트/홈플러스/롯데마트 등)는 실제로는 식료품 외 품목도 포함하지만,
  // 21개 SpendingCategory 중 가장 근접한 단일 대상은 grocery다.
  ["대형마트", "grocery"],
  // "외화결제"는 해외통화 결제를 뜻해 `detectTarget()`이 이미 원문 텍스트의 "해외"를
  // 인식하는 것과 같은 개념(overseas)이다.
  ["외화결제", "overseas"],
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

/**
 * `TIER_CAP_LINE`과 구간/threshold 구조(`N구간 (X만원 이상[~Y만원 미만])`)는 같지만
 * 끝맺음이 "：Z만원" 하나가 아니라 "：Z만원 청구할인"/"：Z천원 할인"/"：월 이용금액 Z만원까지
 * 청구할인"처럼 원/천원/만원 단위 + "청구할인"/"할인"로 끝나는 실제 표현(예: KB국민
 * 굿데이카드 "1구간(전월 이용실적 30만원 이상 60만원 미만) : 월 이용금액 20만원까지
 * 청구할인"). 괄호 안에 "전월 (이용)실적"이 threshold 숫자 앞에 붙는 표현도 실제 데이터에서
 * 확인되어 함께 허용한다. `TIER_CAP_LINE`이 이미 처리하는 줄과는 끝맺음이 겹치지 않는다
 * (하나는 숫자+만원으로 줄이 끝나야 하고, 다른 하나는 반드시 "청구할인"/"할인"로 끝나야 한다).
 */
const TIER_CAP_LINE_ALT =
  /^(\d+)구간\s*\((?:전월\s*(?:이용)?실적\s*)?(\d+)만원\s*이상(?:\s*~?\s*\d+만원\s*미만)?\)\s*:\s*(?:월\s*이용금액\s*)?([\d,]+)(만원|천원|원)\s*(?:까지\s*)?(?:청구할인|할인)\s*$/;

/**
 * "전월 이용금액에 관계없이"만을 대상으로 한다 — 원문이 전월실적 조건 자체가 없다고
 * 직접 명시하는, 실제 데이터에서 확인된 표현이다("관계없이"가 "할인한도"/"적립한도"가
 * 아니라 "전월 이용금액"을 직접 수식한다). "할인한도 없이"/"적립한도 없이"만 단독으로
 * 있는 경우는 한도가 없다는 뜻일 뿐 실적 구간 자체가 없다는 뜻은 아니므로 이 정규식의
 * 대상이 아니다(별도 처리— `noRewardCapMatch` 참고). "무실적"/"전월실적 없이" 등 다른
 * 동의 표현은 이번 범위에서 의도적으로 제외한다(추가 검증 없이 확장하지 않는다).
 */
const NO_PERFORMANCE_REQUIREMENT_MATCH = /전월\s*이용금액에\s*관계없이/;

/**
 * 소비 카테고리 기반 혜택(spendingBenefit)이 아닌 것으로 실제 데이터에서 확인된
 * 부가서비스 마커. 이 목록에 있다고 바로 범위 밖으로 두지 않는다 — 반드시
 * `SPENDING_REWARD_SIGNAL`과 함께 "이 row 전체에 소비 연동 혜택 신호가 전혀 없을
 * 때만" 적용한다(아래 `processBenefitRow()` 참고). 라운지/메탈 플레이트/발급 수수료/
 * 발레파킹 4종으로 범위를 좁혔다 — "임신"/"출산"/"보육료"/"국가바우처"/"국제브랜드"
 * 등은 실제 데이터에서 정상 소비 혜택 row(예: "보육료 10% 청구할인")를 오염시키는
 * 사례가 확인되어 이번 범위에서 제외했다.
 */
const NON_SPENDING_MARKERS = ["라운지", "메탈 플레이트", "메탈플레이트", "발레파킹", "발레 파킹"];

/**
 * "발급 수수료"는 카드 자체의 발급 비용을 뜻하는 일반적인 표현이지만, "민원 발급
 * 수수료"(관공서 민원서류 발급 수수료)는 카드 발급과 무관하게 "실적/적립 제외 대상"
 * 각주에 흔히 등장하는 표현이다(전체 데이터에서 "발급 수수료" 앞에 오는 단어를 전수
 * 확인한 결과, "민원"만 유일하게 무관한 문맥이었다). 이걸 그대로 두면 실제 소비 연동
 * 마일리지 적립 row(cardAdId=10681, "3,000원당 1 대한항공 마일리지 법인 크레딧
 * 적립")가 "[적립 제외 대상] 민원 발급 수수료" 각주 때문에 통째로 제외되는 오탐이
 * 실측으로 확인되어, 이 표현만 별도로 제외한다.
 */
const ISSUANCE_FEE_MARKER = /(?<!민원\s?)발급\s*수수료/;

function hasNonSpendingMarker(summary: string, fullBenefitText: string): boolean {
  const combined = `${summary}\n${fullBenefitText}`;
  return NON_SPENDING_MARKERS.some((m) => combined.includes(m)) || ISSUANCE_FEE_MARKER.test(combined);
}

/**
 * "이 row에 소비 금액과 연동된 혜택을 암시하는 표현이 있는가"를 넓게 판단한다.
 * `detectReward()`처럼 실제로 parsed 값까지 확정하지는 않는다 — 포인트/마일리지처럼
 * `detectReward()`가 원화로 환산하지 못해 결국 unverified로 남기는 값도 여기서는
 * "혜택 신호 있음"으로 본다. 그렇지 않으면 "라운지 + M포인트 적립"처럼 실제로는 소비
 * 혜택이 함께 있는 row를 라운지 마커만 보고 통째로 제외해버리게 된다. "N원당 M포인트/
 * 마일리지" 사이에 "대한항공"처럼 브랜드명이 끼는 실제 표현(예: "3,000원당 1 대한항공
 * 마일리지 적립")도 인식하도록 단위어 앞에 짧은 수식어를 허용한다. `NON_SPENDING_MARKERS`
 * 게이트 전용 판정이며, 대상 row(라운지/메탈 플레이트/발급 수수료/발레파킹) 범위 밖에서는
 * 쓰지 않는다.
 */
const SPENDING_REWARD_SIGNAL =
  /\d+(?:\.\d+)?%|\d+[,\d]*\s*원\s*(?:할인|적립|캐시백)|\d+[,\d]*\s*원당\s*\d+\s*[가-힣A-Za-z]{0,10}\s*(?:마일|포인트|마일리지)|포인트\s*적립|마일리지\s*적립|청구할인/;

interface TierCapMatch {
  readonly thresholdWon: number;
  readonly capWon: number;
  readonly line: string;
}

/** "12,000" 같은 콤마 포함 숫자를 단위(만원/천원/원)에 맞춰 원 단위 정수로 바꾼다. */
function altCapAmountToWon(amountText: string, unit: string): number {
  const amount = Number(amountText.replace(/,/g, ""));
  if (unit === "만원") return amount * 10000;
  if (unit === "천원") return amount * 1000;
  return amount;
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

    const exact = TIER_CAP_LINE.exec(line);
    if (exact) {
      const thresholdManwon = Number(exact[2]);
      const capManwon = Number(exact[3]);
      if (isNonNegativeSafeInteger(thresholdManwon) && isNonNegativeSafeInteger(capManwon)) {
        matches.push({ thresholdWon: thresholdManwon * 10000, capWon: capManwon * 10000, line });
      }
      continue;
    }

    // 기존 TIER_CAP_LINE에 안 걸렸을 때만 끝맺음이 다른 표현을 시도한다 — 한 줄이 두
    // 정규식에 동시에 매칭될 일은 없다(끝맺음 요구 조건이 서로 배타적이다).
    const alt = TIER_CAP_LINE_ALT.exec(line);
    if (alt) {
      const thresholdManwon = Number(alt[2]);
      const capWon = altCapAmountToWon(alt[3], alt[4]);
      if (isNonNegativeSafeInteger(thresholdManwon) && isNonNegativeSafeInteger(capWon)) {
        matches.push({ thresholdWon: thresholdManwon * 10000, capWon, line });
      }
    }
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

/**
 * "수수료"/환율 우대 관련 marker. `detectReward()`의 퍼센트 매칭이 소비 reward가 아니라
 * 수수료 면제·환율 우대율을 오인식하지 않도록 쓴다(예: "해외 이용 수수료 100% 할인" →
 * 실제로는 해외 결제 시 부과되는 수수료 자체의 면제이지 소비금액 100% 할인이 아니다).
 *
 * 전체 443-card 데이터셋의 `benefitSummary`에 등장하는 모든 `%`를 전수 조사한 결과,
 * 이 marker들은 항상 같은 `"|"` clause 안에서 `%` 수치와 붙어 등장했다(다른 clause에
 * 걸쳐 우연히 함께 나타난 사례는 없었다) — 그래서 marker 존재 여부를 clause 단위로
 * 판단하면 충분하다.
 */
const FEE_OR_FX_CLAUSE_MARKERS = ["수수료", "환율 우대", "환율우대", "환전 우대", "환전우대"];

/**
 * `summary`를 `"|"` 기준 clause로 나눠, `matchIndex`(`summary` 안에서의 위치)가 속한
 * clause에 `FEE_OR_FX_CLAUSE_MARKERS` 중 하나가 있는지만 확인한다.
 *
 * 검사 대상은 이 clause 하나뿐이다 — 다른 clause에 marker가 있다고 해서 차단하지 않고
 * (예: "해외 최대 2% 혜택 | ... | 해외 이용 수수료 1.3% 청구 할인"에서 앞쪽 "2%" clause는
 * marker가 없으므로 그대로 채택된다), `summary` 밖의 description(`lines`)은 아예 보지
 * 않는다 — description의 "해외 이용 시 별도의 수수료 부과" 같은 유의사항 문구 때문에
 * 정상적인 summary % reward가 오탐 차단되는 일이 없도록 하기 위함이다.
 */
function isPercentageInFeeOrFxClause(summary: string, matchIndex: number): boolean {
  const clauses = summary.split("|");
  let offset = 0;
  for (const clause of clauses) {
    const clauseEnd = offset + clause.length;
    if (matchIndex >= offset && matchIndex < clauseEnd) {
      return FEE_OR_FX_CLAUSE_MARKERS.some((marker) => clause.includes(marker));
    }
    offset = clauseEnd + 1; // "|" 구분자 한 글자만큼 건너뛴다.
  }
  return false;
}

/**
 * "N원당 M마일/마일리지/포인트/P" 엄격 패턴. 수량(그룹2)은 "원당" 바로 뒤(공백만 허용)에,
 * 단위어(그룹3)는 수량 바로 뒤(공백만 허용)에 와야만 매치된다 — 그 사이에 브랜드명이나
 * "최대" 같은 수식어가 끼면 이 자리에서 매치가 실패한다(둘 다 실제 데이터에서 확인된
 * 흔한 형태이지만 이번 범위에서 의도적으로 제외한다, `normalizeCard.test.ts` 참고).
 * 수량이 `\d+`(소수점 없음)라 "1.5마일"류 소수 수량도 같은 이유로 자동 배제된다.
 *
 * 단위어 뒤에는 일부러 경계를 두지 않는다 — "마일리지적립"처럼 공백 없이 바로 다른
 * 한글 단어가 붙는 실제 표현(card_ad_id=10601)이 있어, 경계를 두면 오히려 놓친다.
 * 로마자 "P"만 예외로 `(?![A-Za-z0-9])` 경계를 둔다 — 한 글자라 뒤에 다른 로마자/숫자가
 * 붙으면("5PM"/"5Plus") 완전히 다른 의미일 위험이 있기 때문이다.
 */
const UNIT_REWARD_RX = /([\d,]+)\s*원당\s*(\d+)\s*(마일리지|마일|포인트|P(?![A-Za-z0-9]))/g;

/**
 * `programName`으로 보지 않을 일반 명사 조각. "카드사용액 1,500원당 1마일" 같은 실제
 * 표현에서 숫자 바로 앞의 공백 없는 한 단어("카드사용액")가 문법적으로는 `extractLeadingBrandName`의
 * 단일-단어 조건을 통과하지만 실제로는 브랜드명이 아니다 — 이런 일반 명사를 걸러낸다.
 */
const NON_BRAND_TOKEN_MARKERS = /금액|가맹점|카드|이용|결제|실적|한도|기준|서비스|적립|할인|캐시백|소비/;

/**
 * 매치 시작 위치 바로 앞(같은 줄, 공백만 사이에 둘 수 있음)에 다른 어떤 단어도 섞이지 않은
 * 순수 한 단어가 있을 때만 그 단어를 programName으로 본다 — "대한항공 1,500원당 1마일리지"는
 * 인정하지만, "대한항공 마일리지 적립 서비스 | 1,500원당 1마일리지"처럼 사이에 다른 문구가
 * 낀 경우나 "국내 이용금액 1,500원당 1마일리지"처럼 여러 단어가 앞에 있는 경우는 인정하지
 * 않는다(같은 row의 다른 clause를 뒤져 억지로 결합하지 않는다는 원칙 그대로).
 */
function extractLeadingBrandName(line: string, matchStart: number): string | null {
  const preceding = line.slice(0, matchStart).trimEnd();
  if (preceding.length === 0) return null;
  if (!/^[가-힣A-Za-z]{2,12}$/.test(preceding)) return null;
  if (NON_BRAND_TOKEN_MARKERS.test(preceding)) return null;
  return preceding;
}

interface UnitRewardCandidate {
  readonly unitAmountWon: number;
  readonly quantityPerUnit: number;
  readonly currencyType: "points" | "miles";
  readonly programName: string | null;
  readonly matchedText: string;
}

/** `lines`(요약 포함, 호출자가 합쳐서 넘긴다)의 각 줄에서 `UNIT_REWARD_RX` 후보를 전부 모은다. */
function findUnitRewardCandidates(lines: readonly string[]): readonly UnitRewardCandidate[] {
  const candidates: UnitRewardCandidate[] = [];
  for (const line of lines) {
    UNIT_REWARD_RX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = UNIT_REWARD_RX.exec(line)) !== null) {
      const unitAmountWon = Number(m[1].replace(/,/g, ""));
      const quantityPerUnit = Number(m[2]);
      const unitWord = m[3];
      if (!isNonNegativeSafeInteger(unitAmountWon) || unitAmountWon <= 0) continue;
      if (!isNonNegativeSafeInteger(quantityPerUnit) || quantityPerUnit <= 0) continue;
      const currencyType: "points" | "miles" = unitWord === "포인트" || unitWord === "P" ? "points" : "miles";
      candidates.push({
        unitAmountWon,
        quantityPerUnit,
        currencyType,
        programName: extractLeadingBrandName(line, m.index),
        matchedText: m[0],
      });
    }
  }
  return candidates;
}

/**
 * "N원당 M마일/포인트" 엄격 패턴을 원화 환산 없이 `RewardUnit` 기반 `points`/`miles`
 * `RewardCurrency`로 직접 만든다. 기존 won(퍼센트/월 정액) 경로와 완전히 분리된 별도
 * 분기이며, 이 함수가 아무 후보도 찾지 못하면(`null` 반환) 기존 로직이 그대로 이어진다.
 *
 * `summary`만 보고 `lines`(description)는 보지 않는다 — 실제 443장 전수 회귀 검증에서
 * card_ad_id=2676(신세계백화점 5% 전자할인쿠폰 카드)의 description에 이 row의 실제
 * 혜택과 무관한 일반 안내 문장("신세계 그룹 이용 시 1,000원당 1 포인트가 적립됩니다")이
 * 있어, `lines`까지 훑으면 이 문장이 진짜 혜택(summary의 "5% 전자할인쿠폰", 기존에 이미
 * parsed였던 won 혜택)을 가로채 unverified로 되돌리는 회귀가 실제로 발생함을 확인했다.
 * `summary`는 이 row의 headline reward만 담아 그런 무관한 안내문이 섞일 위험이 훨씬
 * 낮다 — "기존 won parsing을 절대 깨지 않는다"는 안전 조건이 "lines까지 넓게 본다"는
 * 이익보다 우선한다.
 *
 * 안전 조건(모두 실제 데이터로 확인됨, `normalizeCard.test.ts` 참고):
 * - 서로 다른(금액/수량이 다른) 후보가 같은 row에 여러 개 있으면(예: 국내/해외 rate가
 *   다른 card_ad_id=1312) 첫 번째 값만 고르지 않고 통째로 `unverified`로 남긴다 — target과
 *   잘못 결합될 위험을 없애기 위함이다.
 * - programName을 확실히 특정할 수 없으면(`extractLeadingBrandName`이 `null`) 추측하지
 *   않고 `unverified(PROGRAM_NAME_NOT_FOUND)`로 남긴다.
 * - `rateBps`는 points/miles에서 실제로 쓰이지 않는(계산 엔진이 참조하지 않는) 구조적으로만
 *   필요한 필드라 `0`으로 채운다(`rewards.ts`의 `computeSpendingBenefitRewardQuantity` 참고).
 */
function detectUnitBasedPointsOrMiles(
  summary: string,
  provenanceFor: (conditionText: string) => NormalizationProvenance,
): NormalizationOutcome<NormalizedReward> | null {
  const candidates = findUnitRewardCandidates([summary]);
  if (candidates.length === 0) return null;

  const distinctCombos = new Set(
    candidates.map((c) => `${c.currencyType}:${c.unitAmountWon}:${c.quantityPerUnit}`),
  );
  if (distinctCombos.size > 1) {
    return {
      status: "unverified",
      reasonCode: "MULTIPLE_CONFLICTING_VALUES",
      provenance: provenanceFor(
        `서로 다른 단위 기반 적립 값이 한 row에 함께 있어 하나의 reward로 안전하게 표현할 수 없음: ${candidates
          .map((c) => `"${c.matchedText}"`)
          .join(" / ")}`,
      ),
    };
  }

  const first = candidates[0];
  if (!first) return null;
  const programName = candidates.map((c) => c.programName).find((n): n is string => n !== null) ?? null;
  if (programName === null) {
    return {
      status: "unverified",
      reasonCode: "PROGRAM_NAME_NOT_FOUND",
      provenance: provenanceFor(
        `단위 기반 적립 문구는 찾았으나 프로그램명을 명확히 특정할 수 없음: "${first.matchedText}"`,
      ),
    };
  }

  const p = provenanceFor(`"${first.matchedText}" (programName="${programName}")`);
  const currency: RewardCurrency =
    first.currencyType === "miles"
      ? {
          type: "miles",
          programName,
          valuation: null,
          unit: { unitAmount: asWon(first.unitAmountWon), quantityPerUnit: first.quantityPerUnit },
        }
      : {
          type: "points",
          programName,
          valuation: null,
          unit: { unitAmount: asWon(first.unitAmountWon), quantityPerUnit: first.quantityPerUnit },
        };

  return {
    status: "parsed",
    confidence: "exact",
    value: {
      kind: "rate",
      rateBps: { status: "parsed", value: asBasisPoints(0), confidence: "exact", provenance: p },
      currency: { status: "parsed", value: currency, confidence: "exact", provenance: p },
    },
    provenance: p,
  };
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

  // "N원당 M마일/포인트" 엄격 패턴은 won(퍼센트/월 정액) 시도보다 먼저 확인한다 — 이
  // 패턴과 겹치는 기존 분기가 없어(퍼센트는 "%", 월 정액은 "매월/월+원+할인/캐시백" 필수)
  // 순서를 바꿔도 기존 won 경로에는 영향이 없다.
  const unitRewardOutcome = detectUnitBasedPointsOrMiles(summary, provenanceFor);
  if (unitRewardOutcome !== null) return unitRewardOutcome;

  // "국내 X% ... 해외 Y%"처럼 summary 하나에 국내/해외가 함께 등장하고 서로 다른 할인율이
  // 섞여 있으면, 뒤의 percentMatch가 그중 하나(첫 번째 후보)만 집어 다른 쪽을 조용히
  // 누락시킬 위험이 있다 — 실제로 card_ad_id=10707(삼성 iD 해외 3.5 카드)의 "해외 가맹점
  // 3.5% 할인 | 국내 가맹점 0.7% 할인"에서 국내 0.7%가 그렇게 유실되는 것을 실측으로
  // 확인했다. 두 지역이 같은 요율이면(예: "국내 0.7%, 해외 0.7%") 정보 손실이 없으므로
  // 막지 않는다 — summary 안의 서로 다른 값이 2개 이상일 때만 안전하게 unverified로
  // 남긴다(이미 있는 `MULTIPLE_CONFLICTING_VALUES` reason code를 그대로 재사용한다, 새
  // 코드를 추가하지 않는다). 수수료/환율우대 clause의 %는 후보에서 제외한다(기존
  // `isPercentageInFeeOrFxClause`와 동일 기준). lines(설명문)까지는 보지 않는다 — summary
  // 밖의 무관한 문장이 끼어들 위험을 피하기 위해 `detectUnitBasedPointsOrMiles`와 같은
  // 이유로 범위를 summary로 좁힌다.
  if (summary.includes("국내") && summary.includes("해외")) {
    const distinctRateBps = new Set<number>();
    const allPercentRx = /(\d+)(?:\.(\d{1,2}))?%/g;
    let percentCandidate: RegExpExecArray | null;
    while ((percentCandidate = allPercentRx.exec(summary)) !== null) {
      if (isPercentageInFeeOrFxClause(summary, percentCandidate.index)) continue;
      const whole = Number(percentCandidate[1]);
      const fraction = Number((percentCandidate[2] ?? "").padEnd(2, "0"));
      distinctRateBps.add(whole * 100 + fraction);
    }
    if (distinctRateBps.size >= 2) {
      return {
        status: "unverified",
        reasonCode: "MULTIPLE_CONFLICTING_VALUES",
        provenance: provenanceFor(
          `국내/해외에 서로 다른 할인율이 함께 있어 하나의 reward로 안전하게 확정할 수 없음: "${summary}"`,
        ),
      };
    }
  }

  // 단순 퍼센트: "10% 할인", "1.5% 할인 캐시백"처럼 %와 할인/캐시백 단어가 함께 있는 경우.
  // 정수와 소수(최대 소수 둘째 자리, 즉 1bp=0.01% 단위)를 문자열 자릿수 계산으로 정확히
  // basis point 정수로 바꾼다 — `Number("1.5") * 100`처럼 부동소수점 곱셈을 쓰지 않는다.
  // 소수 셋째 자리 이상("1.555%")은 1bp보다 세밀해 정수 basis point로 정확히 표현할 수
  // 없으므로 반올림해서 추측하지 않고 매칭시키지 않는다 — 그대로 unverified로 남는다.
  const percentMatch = /(\d+)(?:\.(\d{1,2}))?%/.exec(summary);
  const hasDiscountWord = summary.includes("할인");
  const hasCashbackWord = summary.includes("캐시백");
  // 첫 번째 percentage candidate라는 기존 선택 기준 자체는 바꾸지 않는다 — 그 candidate가
  // 속한 clause가 수수료/환율 우대 문맥이면 이번 candidate를 채택하지 않고(다음 candidate를
  // 찾으러 가지 않고) 그대로 아래 fixed-amount 검사 → fallback(unverified)으로 넘어간다.
  const isFeeOrFxPercentage = percentMatch !== null && isPercentageInFeeOrFxClause(summary, percentMatch.index);
  if (percentMatch && !isFeeOrFxPercentage && (hasDiscountWord || hasCashbackWord)) {
    const wholePercent = Number(percentMatch[1]);
    const fractionDigits = (percentMatch[2] ?? "").padEnd(2, "0");
    const fractionBps = Number(fractionDigits);
    const rateBpsRaw = wholePercent * 100 + fractionBps;
    if (isNonNegativeSafeInteger(wholePercent) && isNonNegativeSafeInteger(rateBpsRaw)) {
      const rateBps = asBasisPoints(rateBpsRaw);
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

  // "N원당 M마일/포인트" 엄격 패턴이 아닌 포인트/마일리지 표현(예: "적립률 1.5%", 브랜드가
  // 수량보다 먼저 오는 어순, 소수 수량, 여러 clause가 섞인 경우)은 위 `detectUnitBasedPointsOrMiles`가
  // 이미 `null`을 반환해 여기까지 왔다는 뜻이다. 이런 경우까지 값을 지어내진 않는다 —
  // Domain Design Decision 10("임의의 1P=1원 가정을 기본값으로 사용하지 않는다")과
  // "포인트인지 원인지 불명확하면 추측하지 않는다" 원칙 그대로, 아래 fallback을 통해
  // unverified(NO_NUMERIC_VALUE_FOUND)로 남는다.

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

/**
 * "전체/전/모든 가맹점"류 표현. 이 자체는 국내+해외를 통틀어 21개 `SpendingCategory`
 * 전체를 가리키는 명확한 신호다 — 아래 두 함정만 제외하면 그대로 `allExcept: []`로
 * 옮길 수 있다(443장 실측 조사, `card_ad_id` 예시는 각 함수 문서 참고).
 */
const UNIVERSAL_SCOPE_PHRASE = /전체\s*가맹점|전\s*가맹점|모든\s*가맹점|가맹점\s*전체/;

/**
 * "모든 가맹점은 현대카드/BC카드/신한카드/우리카드... 가맹점 등록 및 업종 분류 기준"류는
 * 이 혜택의 대상 범위를 말하는 게 아니라 "가맹점이 어떻게 분류되는지"를 설명하는 카드사
 * 공통 안내 문구다. `card_ad_id=10322`(현대카드ZERO Edition3(할인형))의 "대중교통 업종
 * 0.8% 청구 할인"(명백히 카테고리 한정 혜택)의 description에도 그대로 따라붙는 것을 실제
 * CSV에서 확인했다 — 이 문구가 있는 줄은 범용 신호로 보지 않는다.
 */
function isMerchantClassificationDisclaimer(line: string): boolean {
  return (
    UNIVERSAL_SCOPE_PHRASE.test(line) &&
    line.includes("기준") &&
    (line.includes("등록") || line.includes("분류"))
  );
}

/**
 * "해외 전 가맹점"/"해외 모든 가맹점"처럼 `UNIVERSAL_SCOPE_PHRASE` 바로 앞에 "해외"가
 * 오면 "해외 전체"(overseas 카테고리 하나)를 뜻하지 "국내+해외 전체"를 뜻하지 않는다
 * (`card_ad_id=10219` zgm.휴가중카드 "해외 전가맹점", `card_ad_id=10372` JADE First
 * "해외 : 해외 전 가맹점"에서 확인). 이 경우는 아래 기존 "해외" 단독 분기가 이미 정확히
 * `categories: ["overseas"]`로 처리하므로 여기서 범용으로 승격시키지 않는다.
 *
 * 단, 같은 줄에 "국내"도 함께 있으면 "해외"가 바로 앞에 와도 "해외 단독"이 아니라
 * "국내+해외 결합"(범용)이다 — `card_ad_id=10346`(zgm point카드)의 "국내/해외 전
 * 가맹점에서 NH포인트 0.8%~1.8% 적립"에서 실제로 확인했다: "전 가맹점" 바로 앞의
 * "해외"만 보면 해외 단독처럼 보이지만, 같은 줄의 "국내"가 이게 결합 표현임을 말해준다.
 */
function isOverseasOnlyPhrase(line: string, matchIndex: number): boolean {
  const precedingText = line.slice(Math.max(0, matchIndex - 3), matchIndex);
  if (!precedingText.includes("해외")) return false;
  return !line.includes("국내");
}

/**
 * 이 줄이 실제로 리워드(적립/할인/캐시백/마일리지/포인트)를 말하고 있는지. "모든 가맹점"이
 * 있어도 리워드와 무관한 다른 조건(예: 무이자할부 대상 안내)을 말하는 줄이면 이 혜택의
 * 대상 범위와 상관없다 — `card_ad_id=10540`의 "전국 모든 가맹점 2~3개월 상시 무이자할부"
 * 에서 실제로 확인했다(이 줄은 별개 항목인 무이자할부 조건을 설명할 뿐, 같은 row의 실제
 * 리워드인 "해외 사용금액 10% 할인"과는 무관하다).
 */
const REWARD_INDICATOR = /[%％]|적립|할인|캐시백|마일리지|마일|포인트/;

interface UniversalScopeMatch {
  readonly line: string;
  /** `allExcept.categories`에 그대로 쓸 값. 해외를 포함한다는 신호("해외"/"국내외")가
   * 같은 줄에 없는데 "국내"만 명시돼 있으면, 이 혜택이 해외까지 포함한다고 임의로
   * 확대 해석하지 않고 `["overseas"]`로 제외한다. */
  readonly excludedCategories: readonly SpendingCategory[];
}

/**
 * "국내 모든 가맹점"처럼 "국내"만 있고 같은 줄에 "해외"/"국내외"가 없으면, 이 혜택이
 * 실제로는 국내 전용이고 해외는 제외될 수 있다 — `card_ad_id=10151`(신한카드 플리)의
 * "할인 쿠폰 적용 가맹점은 국내 모든 가맹점에서..."에서 실제로 확인했다(같은 row에
 * "※ 할인 쿠폰은 국내 이용 거래에 한하여 적용됩니다."라는 별도 문구로 해외 제외가
 * 명시돼 있음). 반대로 `card_ad_id=10304`(디지로카 London)의 "국내 모든 가맹점 0.7%,
 * 해외 모든 이용금액 0.7% 캐시백 지급"처럼 같은 줄에 "해외"가 있으면 국내+해외 모두를
 * 뜻하므로 제외하지 않는다. "국내"가 아예 없으면(예: "모든 가맹점 1,000원당 1마일리지")
 * 지역 제한 신호 자체가 없으므로 문언 그대로 전체로 본다.
 */
function resolveUniversalScopeExcludedCategories(line: string): readonly SpendingCategory[] {
  const mentionsDomesticOnly = line.includes("국내") && !line.includes("국내외") && !line.includes("해외");
  return mentionsDomesticOnly ? ["overseas"] : [];
}

/**
 * `lines`를 줄 단위로 검사해 범용 대상을 말하는 줄을 찾는다. `benefit_descriptions_json`의
 * 각 문단이 이미 독립된 문장 단위이므로, 긴 합쳐진 텍스트에서 문자 위치로 앞뒤 문맥을
 * 추정하는 것보다 안전하다(위 함정들을 문단 하나 안에서만 판단한다).
 */
function findUniversalScopeMatch(lines: readonly string[]): UniversalScopeMatch | null {
  for (const line of lines) {
    const match = UNIVERSAL_SCOPE_PHRASE.exec(line);
    if (!match) continue;
    if (isMerchantClassificationDisclaimer(line)) continue;
    if (isOverseasOnlyPhrase(line, match.index)) continue;
    if (!REWARD_INDICATOR.test(line)) continue;
    return { line, excludedCategories: resolveUniversalScopeExcludedCategories(line) };
  }
  return null;
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
  // "간편결제" 바로 뒤에 "등록"이 오는 경우("카드 사용등록일(KB Pay 등 간편결제 등록
  // 포함)로부터...")는 이 benefit의 결제수단 조건이 아니라, 실적유예기간을 설명하는
  // "카드 등록 방법" 안내문이다 — 전체 데이터에서 "간편결제\s*등록" 패턴 118개 행/27개
  // 고유 문맥을 전수 확인한 결과 예외 없이 전부 이 동일한 상용구였다. "간편결제"가
  // 실제 결제/할인/적립 조건으로 쓰이는 경우(예: "온라인 간편결제 1% 할인", "간편결제:
  // 삼성페이, 네이버페이...")는 "간편결제" 바로 뒤에 "등록"이 오지 않으므로 이 조건에
  // 걸리지 않는다 — "간편결제"라는 단어 자체를 무시하는 게 아니라, 등록 안내문 문맥
  // 하나만 좁혀서 제외한다.
  if (/간편결제(?!\s*등록)/.test(combinedText)) {
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

  // 범용(전체/전/모든 가맹점) 대상 표현은 `isDomesticOverseasCombination()`보다 먼저
  // 확인한다. 그 함수는 "국내"+"해외"+"합산"/"통합"이 텍스트 어디엔가 함께 있으면
  // (실제로는 서로 무관한 문장에서 각각 등장한 경우까지 포함해) true를 반환하는 넓은
  // 휴리스틱이라, "국내 모든 가맹점 0.7%, 해외 모든 이용금액 0.7% 캐시백"처럼 명확한
  // 범용 대상 문장까지 `DOMESTIC_OVERSEAS_COMBINATION`으로 잘못 분류하는 것을 실제
  // 데이터(`card_ad_id=10304` 디지로카 London, `10396` 트래블로그 PRESTIGE)에서 확인했다.
  // `findUniversalScopeMatch()`은 위 함정들(안내 문구/해외 단독/리워드 무관 줄)을 이미
  // 걸러내는 좁은 판정이므로, 여기서 먼저 확인해도 다른 카드의 `DOMESTIC_OVERSEAS_COMBINATION`
  // 처리에는 영향이 없다(그 판정을 흔드는 "국내외"류 표현 자체가 이 조건에 걸리지 않는다).
  const universalScopeMatch = findUniversalScopeMatch(lines);
  if (universalScopeMatch !== null) {
    return {
      outcome: {
        status: "parsed",
        confidence: "exact",
        value: { type: "allExcept", categories: universalScopeMatch.excludedCategories },
        provenance: provenanceFor(`범용(전체/모든 가맹점) 대상: "${universalScopeMatch.line}"`),
      },
      unsupportedCode: null,
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

/**
 * 안전하게 확정된 다구간(D) row를 tier 개수만큼의 `NormalizedSpendingBenefitPiece`로
 * 분해한다. `target`/`reward`/`minMonthlySpend`는 tier마다 실제로 값이 달라지는 필드가
 * 아니다(D의 안전 범위 자체가 "구간마다 requiredTierId/limits만 다르고 나머지는 같다"로
 * 한정돼 있다) — 그래도 각 piece가 자신만의 정확한 provenance(pieceIndex 포함)를 갖도록
 * `detectTarget`/`detectReward`를 tier마다 다시 호출한다. 두 함수 모두 순수 함수라 같은
 * 입력에는 항상 같은 값을 반환하므로, 이렇게 해도 tier 사이에 값 자체가 달라지지 않는다.
 *
 * exclusiveGroupId/priority는 이 piece 타입에 없다(기존 단일 piece 경로와 동일한 이유 —
 * `NormalizedSpendingBenefitPiece`의 문서 참고). 실제 배타 그룹 구성은 `toDomainCard()`가
 * `NormalizedBenefit.pieces`가 2개 이상인지를 보고 결정한다.
 */
function buildTierDecomposedPieces(
  card: RawCardRecord,
  raw: RawBenefitRecord,
  lines: readonly string[],
  summary: string,
  benefitOrder: number,
  tierCapMatches: readonly TierCapMatch[],
  provenanceFor: (
    conditionText: string,
    pieceIndex: number | null,
    originalBenefitText: string | null,
  ) => NormalizationProvenance,
  fullBenefitText: string,
): readonly NormalizedSpendingBenefitPiece[] {
  // threshold 오름차순으로 pieceIndex를 부여한다 — 정답성에는 영향이 없지만(승자 결정은
  // eligibility.ts가 threshold 값 자체로 하지 배열 순서로 하지 않는다) id/provenance가
  // "1구간, 2구간, ..." 순서와 일치해 읽기 쉽다.
  const sortedMatches = [...tierCapMatches].sort((a, b) => a.thresholdWon - b.thresholdWon);

  return sortedMatches.map((m, pieceIndex) => {
    const pieceProvenanceFor = (conditionText: string): NormalizationProvenance =>
      provenanceFor(conditionText, pieceIndex, fullBenefitText);

    const { outcome: target } = detectTarget(raw.benefitCategory, lines, pieceProvenanceFor);
    const reward = detectReward(summary, lines, pieceProvenanceFor);
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

    const piece: NormalizedSpendingBenefitPiece = {
      kind: "spendingBenefit",
      benefitId: createBenefitId(card.cardAdId, benefitOrder, pieceIndex),
      name: {
        status: "parsed",
        confidence: "exact",
        value: summary,
        provenance: pieceProvenanceFor(`benefit_summary="${summary}"`),
      },
      requiredTierId: {
        status: "parsed",
        confidence: "exact",
        value: createPerformanceTierId(card.cardAdId, asWon(m.thresholdWon)),
        provenance: pieceProvenanceFor(`"${m.line}"`),
      },
      target,
      minMonthlySpend,
      reward,
      limits: {
        status: "parsed",
        confidence: "exact",
        value: { monthlyRewardCap: asWon(m.capWon), monthlyEligibleSpendCap: null },
        provenance: pieceProvenanceFor(`"${m.line}"`),
      },
      sharedCapId: {
        status: "parsed",
        confidence: "exact",
        value: null,
        provenance: pieceProvenanceFor('"통합"/"합산" 문구 없음 — 이 benefit 단독 한도(다구간 분해로 생성된 piece)'),
      },
      provenance: pieceProvenanceFor(fullBenefitText.slice(0, 200)),
    };
    return piece;
  });
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

  // 라운지/메탈 플레이트/발급 수수료/발레파킹처럼 소비 카테고리 기반 혜택이 아닌 것으로
  // 확인된 마커가 있고, 이 row 어디에도 소비 연동 혜택 신호가 전혀 없는 경우만 범위
  // 밖으로 둔다. 마커가 있어도 소비 혜택 신호가 함께 있으면(예: "라운지 + 5% 할인",
  // "발레파킹 + 청구할인") 제외하지 않고 기존처럼 spendingBenefit 파이프라인을 그대로
  // 통과시킨다 — 이런 row를 perk/spending으로 정확히 나누려면 별도의 segmentation이
  // 필요하고, 이번 범위가 아니다(위 `NON_SPENDING_MARKERS`/`SPENDING_REWARD_SIGNAL` 참고).
  if (hasNonSpendingMarker(summary, fullBenefitText) && !SPENDING_REWARD_SIGNAL.test(`${summary}\n${fullBenefitText}`)) {
    const provenance = provenanceFor(fullBenefitText.slice(0, 200), null, fullBenefitText);
    return {
      benefit: { sourceBenefitOrder: benefitOrder, pieces: [] },
      wholeRowWarning: {
        code: "NON_SPENDING_ROW",
        message: "라운지/메탈 플레이트/발급 수수료/발레파킹 등 소비 연동 혜택이 아닌 것으로 확인되어 범위 밖 처리",
        provenance,
      },
      tierThresholds: [],
    };
  }

  // "▶"는 이 데이터셋에서 하나의 개별 sub-benefit 설명을 시작하는 불릿 마커로 쓰인다
  // (예: "▶ 해외 2% 결제일할인", "▶ 국내 가맹점 0.7% 결제일할인"). 이 마커가 같은 row
  // 안에 2개 이상 있으면, 그 row는 서로 다른 sub-benefit(대상/요율이 각각 다를 수 있는)이
  // 함께 서술된 composite row일 가능성이 있다. 그런데 `detectTarget()`/`detectReward()`는
  // row당 정확히 하나의 target/reward만 찾도록 설계돼 있어(§ 각 함수 문서 참고), composite
  // row라도 두 함수가 서로 다른 sub-benefit에서 값을 가져와 실제로는 원문에 없는 조합을
  // 만들 위험이 있다(예: target은 "해외" sub-benefit에서, reward는 다른 sub-benefit에서
  // 매칭되는 경우). 이걸 sub-benefit 단위로 정확히 분해하는 것은 이번 범위가 아니므로
  // (새로운 segmentation parser가 필요하다), 안전하게 이 row 전체를 범위 밖으로 두고
  // 계산에 반영하지 않는다 — 혜택을 놓치는 것이 잘못된 조합을 계산하는 것보다 낫다.
  const compositeMarkerCount = (fullBenefitText.match(/▶/g) ?? []).length;
  if (compositeMarkerCount >= 2) {
    const provenance = provenanceFor(fullBenefitText.slice(0, 200), null, fullBenefitText);
    return {
      benefit: { sourceBenefitOrder: benefitOrder, pieces: [] },
      wholeRowWarning: {
        code: "COMPOSITE_ROW",
        message: `"▶" 마커가 ${compositeMarkerCount}개 발견되어 서로 다른 sub-benefit이 섞인 composite row일 가능성이 있어 범위 밖 처리`,
        provenance,
      },
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

  // "월 5회", "일 1회", "연 12회"처럼 금액이 아니라 횟수로 상한을 두는 조건. 원래는 아래
  // `limits`/`sharedCapId` 판정 직전에 선언돼 있었으나, D(다구간 분해) 안전 조건 판정이
  // 이 값을 먼저 참조해야 해서 위로 옮겼다 — `fullBenefitText`에 대한 순수 정규식 매칭일
  // 뿐이라 위치를 옮겨도 값 자체는 달라지지 않는다.
  const usageCountLimitMatch = /(?:월|일|연)\s*\d+\s*회/.exec(fullBenefitText);

  // ---------------------------------------------------------------------------
  // D: 안전한 다구간(multi-tier) 분해
  // ---------------------------------------------------------------------------
  //
  // 아래 조건을 모두 만족할 때만 이 row를 여러 piece로 분해한다. 하나라도 어긋나면 억지로
  // 분해하지 않고 기존 단일 piece 경로(아래)로 넘어가 지금까지와 동일하게 처리한다(2개 이상
  // matches는 기존처럼 requiredTierId/limits가 AMBIGUOUS_*로 unverified 유지).
  //
  // - `tierCapMatches.length >= 2`: 구간이 실제로 2개 이상 존재.
  // - `!hasSharedGroupSignal`: "통합" 한도가 아님 — 어느 benefit들과 한도를 나눠 쓰는지
  //   카드 전체를 훑어야 알 수 있는 구조라 이번 범위 밖이다.
  // - `!usageCountLimitMatch`: 횟수 제한이 아님 — 원화 한도로 표현할 수 없다.
  // - `!hasAnnualPerformanceSignal`: "연간 결제실적"처럼 월간이 아닌 기간 조건이 섞여
  //   있지 않음. 실제 데이터(cardAdId=2487)에서 월간 구간표와 별개로 "연간 결제실적
  //   1,500만원 충족 가정" 같은 문구가 같은 row 안에 함께 나타나는 사례가 확인되었다 —
  //   `PerformanceTier`/`MonthlySpending`은 월간 실적만 다루므로 섞이면 분해하지 않는다.
  // - `tierLineCount === tierCapMatches.length`: 텍스트의 모든 "N구간" 줄이 예외 없이
  //   매칭됐음. 실제 데이터(cardAdId=10302)에서 "1만 5천원"처럼 숫자와 한글이 섞인 금액
  //   표기 때문에 3개 구간 중 2개만 매칭된 사례가 확인되었다 — 일부만 매칭된 채로
  //   분해하면 중간 구간이 통째로 빠져, 그 구간에 해당하는 사용자가 더 낮은(틀린) 구간의
  //   혜택으로 잘못 계산될 위험이 있다. 그래서 전부 매칭되지 않으면 전혀 분해하지 않는다.
  // - `distinctThresholdCount === tierCapMatches.length`: 매칭된 threshold가 서로 중복되지
  //   않음. 실제 데이터(cardAdId=10481)에서 "①~④ 중 택1"류 옵션 번들처럼 같은 구간표가
  //   반복돼 동일한 threshold가 여러 번 매칭되는 사례가 확인되었다 — 이런 row도 안전하게
  //   구간과 혜택을 1:1로 결정할 수 없으므로 분해하지 않는다.
  const tierLineCount = lines.filter((l) => /^\d+구간/.test(l.trim())).length;
  const hasAnnualPerformanceSignal = /연간\s*(결제)?\s*실적/.test(fullBenefitText);
  const distinctThresholdCount = new Set(tierCapMatches.map((m) => m.thresholdWon)).size;
  const isSafeMultiTierDecomposition =
    tierCapMatches.length >= 2 &&
    !hasSharedGroupSignal &&
    !usageCountLimitMatch &&
    !hasAnnualPerformanceSignal &&
    tierLineCount === tierCapMatches.length &&
    distinctThresholdCount === tierCapMatches.length;

  if (isSafeMultiTierDecomposition) {
    const pieces = buildTierDecomposedPieces(
      card,
      raw,
      lines,
      summary,
      benefitOrder,
      tierCapMatches,
      provenanceFor,
      fullBenefitText,
    );
    // 여러 piece 중 하나라도 unsupported 필드가 있으면 그중 먼저 발견된 code를 카드 단위
    // 경고로 남긴다 — 단일 piece 경로의 `dominantUnsupportedCode`와 같은 목적이다.
    let dominantUnsupportedCode: UnsupportedConditionCode | null = null;
    for (const p of pieces) {
      const code = findUnsupportedCode(p);
      if (code !== null) {
        dominantUnsupportedCode = code;
        break;
      }
    }
    return {
      benefit: { sourceBenefitOrder: benefitOrder, pieces },
      wholeRowWarning:
        dominantUnsupportedCode !== null
          ? {
              code: dominantUnsupportedCode,
              message: "일부 필드가 범위 밖 조건으로 unsupported 처리됨(피스 자체는 보존됨, 다구간 분해)",
              provenance: provenanceFor(fullBenefitText.slice(0, 200), null, fullBenefitText),
            }
          : null,
      tierThresholds,
    };
  }

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
  } else if (tierCapMatches.length === 0 && NO_PERFORMANCE_REQUIREMENT_MATCH.test(fullBenefitText)) {
    // 구간 문구가 아예 없는(0개) 경우 중에서도, 원문이 "전월 이용금액에 관계없이"로
    // 실적 조건 자체가 없다고 직접 명시하는 경우만 확정된 사실(`null` = 실적 구간 조건
    // 없음, `types/benefit.ts`의 `requiredTierId` 문서 그대로)로 다룬다. 숫자가 없다는
    // 이유만으로 임의로 null을 만드는 게 아니라, 원문이 직접 "관계없이"라고 말하는
    // 이 표현만 대상으로 한다(기존 `noRewardCapMatch`와 같은 원칙).
    requiredTierId = {
      status: "parsed",
      confidence: "exact",
      value: null,
      provenance: pieceProvenanceFor('"전월 이용금액에 관계없이" — 원문이 실적 구간 조건 없음을 직접 명시'),
    };
  } else {
    // 0개(명시적 구간 문구도, 무실적 문구도 없음) 또는 2개 이상(여러 구간이 한
    // benefit에 섞여 있어 이번 단계의 단순 모델로는 어느 것을 요구 구간으로 볼지
    // 결정할 수 없음).
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

  // (`usageCountLimitMatch`는 D 안전 조건 판정을 위해 이 함수 위쪽으로 옮겼다 — 요율/대상
  // 자체는 맞을 수 있지만 실제 월 혜택은 결제 건수에 의존하므로 원화 한도로 표현할 수
  // 없다는 이유는 그대로다.)

  // "할인한도 없이"/"적립한도 없이"/"한도 없이": 원문이 스스로 한도가 없다고 명시한
  // 경우다. 이건 "한도를 확인할 수 없음"(unverified)이 아니라 "한도 자체가 없음"이라는
  // 확정된 사실이며, `BenefitLimits.monthlyRewardCap`은 이미 `Won | null`이고 `null`이
  // "한도 없음"을 뜻하도록 정의돼 있다(types/benefit.ts). 그래서 숫자가 없다는 이유만으로
  // 임의로 null을 만드는 게 아니라, 원문이 직접 "없다"고 말하는 이 표현들만 대상으로 한다.
  // "한도\s*없이"를 세 번째 대안으로 추가했지만("할인"/"적립" 수식어 없이 "한도 없이"만
  // 단독으로 쓰인 경우 — 실제 데이터에서 확인됨: cardAdId=10589/10590 "전월 이용금액에
  // 관계없이, 한도 없이 서비스 제공"), 정규식 대안(|) 평가는 가장 왼쪽에서 매치되는
  // 위치를 찾으므로 "할인한도 없이"/"적립한도 없이"처럼 수식어가 붙은 경우는 항상 그
  // 대안이 먼저(더 이른 위치에서) 매치되어 기존 동작이 그대로 유지된다 — "한도 없이"만
  // 새로 추가로 인식하는 것이지 기존 두 표현의 매치 결과를 바꾸지 않는다. "한도 금액"/
  // "한도 내"/"한도 초과"/"한도 적용"/"한도 변경"처럼 "없이"가 뒤따르지 않는 문구는
  // 이 정규식 자체가 매치하지 않는다.
  const noRewardCapMatch = /할인한도\s*없이|적립한도\s*없이|한도\s*없이/.exec(fullBenefitText);

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
  } else if (noRewardCapMatch) {
    limits = {
      status: "parsed",
      confidence: "exact",
      value: { monthlyRewardCap: null, monthlyEligibleSpendCap: null },
      provenance: pieceProvenanceFor(`"${noRewardCapMatch[0]}" — 원문이 한도 없음을 직접 명시`),
    };
    sharedCapId = {
      status: "parsed",
      confidence: "exact",
      value: null,
      provenance: pieceProvenanceFor('"통합"/"합산" 문구 없음 — 이 benefit 단독 한도(한도 자체가 없음)'),
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
