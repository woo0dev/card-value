import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeCard } from "./normalizeCard";
import type { RawBenefitRecord, RawCardRecord } from "./types";
import type { NormalizedBenefitPiece } from "./normalizeTypes";

/**
 * `normalizeCard()`의 범용(전체/전/모든 가맹점) target 정규화를 검증한다.
 *
 * 이 프로젝트에는 아직 별도의 테스트 러너가 설치돼 있지 않다(AGENTS.md 11번 원칙:
 * "테스트 러너 선택 및 설치는 별도의 작업으로 진행한다"). 그래서 새 테스트 프레임워크를
 * 추가하는 대신, Node.js에 이미 내장된 `node:test`/`node:assert`만 사용한다 — 이미 설치된
 * `tsx`로 그대로 실행 가능하고(`npx tsx --test src/lib/card-data/normalizeCard.test.ts`),
 * 새 dependency가 전혀 필요 없다.
 *
 * `parseCsv.ts`를 거치지 않고 `RawCardRecord`/`RawBenefitRecord`를 직접 만든다 — 이 테스트가
 * 검증하려는 것은 `normalizeCard()`의 target 판정 로직이지 CSV 파싱이 아니기 때문이다.
 */

function buildRawCard(overrides: Partial<RawCardRecord> = {}): RawCardRecord {
  return {
    cardAdId: "test-card",
    cardCode: null,
    cardName: "테스트 카드",
    issuerCode: null,
    issuerName: "테스트카드사",
    sourceUrl: "https://example.com/test-card",
    issuerCardUrl: null,
    annualFeeDomestic: "10000",
    annualFeeInternational: null,
    annualFeeFamily: null,
    annualFeeDescription: null,
    minimumSpendFrom: null,
    minimumSpendTo: null,
    minimumSpendUnit: null,
    minimumSpendPeriod: null,
    minimumSpendMethod: null,
    minimumSpendDescription: null,
    titleDescription: null,
    alertDescription: null,
    benefitSummary: null,
    newMemberBenefit: null,
    releaseDate: null,
    benefitCount: null,
    annualBrandFeesJson: null,
    benefitNoticesJson: null,
    extraDescJson: null,
    rateNoticesJson: null,
    raw: {},
    ...overrides,
  };
}

/**
 * `descriptionLines`를 실제 `benefit_descriptions_json`과 같은 모양(문단 배열의 배열)으로
 * 감싼다 — `normalizeCard.ts`의 `parseDescriptionLines()`가 실제로 읽는 형태와 동일하다.
 */
function buildRawBenefit(overrides: {
  readonly benefitOrder?: string;
  readonly benefitCategory?: string | null;
  readonly benefitSummary?: string | null;
  readonly descriptionLines?: readonly string[];
}): RawBenefitRecord {
  return {
    cardAdId: "test-card",
    cardName: "테스트 카드",
    issuerCode: null,
    issuerName: "테스트카드사",
    benefitOrder: overrides.benefitOrder ?? "1",
    benefitCategory: overrides.benefitCategory ?? null,
    benefitCategoryId: null,
    benefitSummary: overrides.benefitSummary ?? null,
    benefitValuesJson: null,
    benefitDescriptionsJson: JSON.stringify([overrides.descriptionLines ?? []]),
    benefitDescription: (overrides.descriptionLines ?? []).join(" | "),
    benefitIcon: null,
    raw: {},
  };
}

/** 카드 1장(혜택 1개)을 정규화해 그 혜택의 첫 번째 소비 혜택 piece를 돌려준다. */
function normalizeSingleSpendingPiece(benefit: RawBenefitRecord): NormalizedBenefitPiece {
  const card = buildRawCard({ cardAdId: benefit.cardAdId });
  const normalized = normalizeCard(card, [benefit]);
  const piece = normalized.benefits[0]?.pieces[0];
  assert.ok(piece, "정규화 결과에 piece가 없음 — 테스트 입력이 잘못됨");
  return piece;
}

describe("normalizeCard() — 범용(전체/전/모든 가맹점) target 정규화", () => {
  it("Case A: '전 가맹점 1% 적립' → allExcept: [] (범용, 지역 제한 신호 없음)", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "포인트/캐시백",
        benefitSummary: "전 가맹점 최대 1% 적립",
        descriptionLines: ["전 가맹점 1% 포인트 적립"],
      }),
    );
    assert.equal(piece.kind, "spendingBenefit");
    const target = piece.kind === "spendingBenefit" ? piece.target : null;
    assert.equal(target?.status, "parsed");
    assert.deepEqual(target?.status === "parsed" ? target.value : null, {
      type: "allExcept",
      categories: [],
    });
  });

  it("Case B-1: 실제 카드(card_ad_id=10304 디지로카 London)와 동일한 문장 → allExcept: [] (국내+해외 모두 명시)", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "의료",
        benefitSummary: "의료 업종 최대 1.7% 캐시백",
        descriptionLines: ["[기본 캐시백]", "국내 모든 가맹점 0.7%, 해외 모든 이용금액 0.7% 캐시백 지급"],
      }),
    );
    const target = piece.kind === "spendingBenefit" ? piece.target : null;
    assert.equal(target?.status, "parsed");
    assert.deepEqual(target?.status === "parsed" ? target.value : null, {
      type: "allExcept",
      categories: [],
    });
  });

  it("Case B-2: 실제 카드(card_ad_id=10151 신한카드 플리)와 동일한 문장 → allExcept: ['overseas'] (국내만 명시, 해외 언급 없음)", () => {
    // "국내 모든 가맹점"만 있고 같은 줄에 "해외"/"국내외"가 없으면 해외까지 포함한다고
    // 임의로 확대 해석하지 않는다 — 실제로 이 카드는 다른 줄에서 "국내 이용 거래에
    // 한하여 적용됩니다"라고 명시한다(전체 원문은 §5 조사 결과 참고).
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "바우처",
        benefitSummary: "최대 6천원 할인 쿠폰 제공",
        descriptionLines: ["할인 쿠폰 적용 가맹점은 국내 모든 가맹점에서 이용한 거래에 자동 적용되며 3천원 할인"],
      }),
    );
    const target = piece.kind === "spendingBenefit" ? piece.target : null;
    assert.equal(target?.status, "parsed");
    assert.deepEqual(target?.status === "parsed" ? target.value : null, {
      type: "allExcept",
      categories: ["overseas"],
    });
  });

  it("Case B-3: 실제 카드(card_ad_id=10396 트래블로그 PRESTIGE)와 동일한 문장 → allExcept: [] ('국내외' 결합 표현)", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "항공마일리지",
        benefitSummary: "대한항공 마일리지 적립 서비스 | 1,500원당 1마일리지",
        descriptionLines: ["국내외 전 가맹점(대한항공 마일리지 적립) : 1,500원당 1마일리지 적립 (월 적립 한도 없음)"],
      }),
    );
    const target = piece.kind === "spendingBenefit" ? piece.target : null;
    assert.equal(target?.status, "parsed");
    assert.deepEqual(target?.status === "parsed" ? target.value : null, {
      type: "allExcept",
      categories: [],
    });
  });

  it("Case C: '주유 3% 할인' → 기존 categories target 유지(회귀 없음)", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "주유",
        benefitSummary: "주유 3% 청구할인",
        descriptionLines: ["주유: 주유소, 충전소 업종"],
      }),
    );
    const target = piece.kind === "spendingBenefit" ? piece.target : null;
    assert.equal(target?.status, "parsed");
    assert.deepEqual(target?.status === "parsed" ? target.value : null, {
      type: "categories",
      categories: ["fuel"],
    });
  });

  it("Case D: '기본 적립 1%'만으로는 allExcept: []가 되지 않는다('가맹점' 단어 자체가 없음)", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: null,
        benefitSummary: "기본 적립 1%",
        descriptionLines: ["기본 적립 1% 포인트 적립"],
      }),
    );
    const target = piece.kind === "spendingBenefit" ? piece.target : null;
    // "가맹점"이라는 단어 자체가 없으므로 범용 판정에 걸리지 않는다 — rawCategory도
    // 매핑표에 없으므로 unverified(AMBIGUOUS_TARGET_CATEGORY)로 남아야 한다.
    assert.notEqual(target?.status, "parsed");
  });

  it("Case D-보강: '기본적립' + 카테고리 한정 문맥이면 allExcept: []가 되지 않는다(카테고리 매핑 유지)", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "카페/베이커리",
        benefitSummary: "카페 5% 기본적립",
        descriptionLines: ["[기본적립처] 카페 업종 5% 포인트 적립"],
      }),
    );
    const target = piece.kind === "spendingBenefit" ? piece.target : null;
    assert.equal(target?.status, "parsed");
    assert.deepEqual(target?.status === "parsed" ? target.value : null, {
      type: "categories",
      categories: ["cafe"],
    });
  });

  it("Case E: 회귀 방지 — '모든 가맹점은 [카드사] 가맹점 등록 기준' 안내 문구만으로는 범용이 되지 않는다(card_ad_id=10322 재현)", () => {
    // 실제 데이터에서 "대중교통 업종 0.8% 청구 할인"(명백히 카테고리 한정)의 description에
    // "모든 가맹점은 현대카드 가맹점 등록 및 업종 분류 기준"이라는 보일러플레이트 안내
    // 문구가 그대로 따라붙는 것을 실제 CSV에서 확인했다 — 이 문구만으로 allExcept: []가
    // 되면 회귀다.
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "대중교통",
        benefitSummary: "대중교통 업종 0.8% 청구 할인",
        descriptionLines: ["실적, 할인 한도 제한 없음", "모든 가맹점은 현대카드 가맹점 등록 및 업종 분류 기준"],
      }),
    );
    const target = piece.kind === "spendingBenefit" ? piece.target : null;
    assert.equal(target?.status, "parsed");
    assert.deepEqual(target?.status === "parsed" ? target.value : null, {
      type: "categories",
      categories: ["public_transport"],
    });
  });

  it("Case E-보강: 회귀 방지 — '해외 전 가맹점'(해외 단독)은 allExcept가 아니라 overseas 카테고리로 유지(card_ad_id=10372 재현)", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "항공마일리지",
        benefitSummary: "해외 이용 3% 적립",
        descriptionLines: ["적립 대상 가맹점", "해외 : 해외 전 가맹점 3% 적립"],
      }),
    );
    const target = piece.kind === "spendingBenefit" ? piece.target : null;
    assert.equal(target?.status, "parsed");
    assert.deepEqual(target?.status === "parsed" ? target.value : null, {
      type: "categories",
      categories: ["overseas"],
    });
  });

  it("Case E-보강2: 회귀 방지 — 리워드와 무관한 '모든 가맹점' 문장(무이자할부 안내)은 무시된다(card_ad_id=10540 재현)", () => {
    // 이 row는 실제로는 "해외 사용금액 10% 할인"이 진짜 리워드이고, "전국 모든 가맹점
    // 2~3개월 무이자할부"는 완전히 별개인 할부 조건 안내다. "모든 가맹점"이 있다고
    // 무조건 allExcept: []가 되면 안 된다 — 기존 "해외" 단독 분기가 그대로 살아 있어야 한다.
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "언제나할인",
        benefitSummary: "해외 사용금액 10% 할인",
        descriptionLines: ["해외 온/오프라인 가맹점", "전국 모든 가맹점 2~3개월 상시 무이자할부"],
      }),
    );
    const target = piece.kind === "spendingBenefit" ? piece.target : null;
    assert.equal(target?.status, "parsed");
    assert.deepEqual(target?.status === "parsed" ? target.value : null, {
      type: "categories",
      categories: ["overseas"],
    });
  });
});

/**
 * `detectReward()`에 추가한 "N원당 M마일/마일리지/포인트/P" 엄격 패턴(`detectUnitBasedPointsOrMiles`)을
 * 검증한다. 지원 범위는 의도적으로 좁다 — 수량이 "원당" 바로 뒤에(공백만 허용) 오고, 단위어가
 * 수량 바로 뒤에(공백만 허용) 오는 경우만 지원하며, 브랜드가 수량보다 먼저 오는 어순, 소수
 * 수량, "최대" 수식어, 한 row에 여러 rate가 섞인 경우, programName을 특정할 수 없는 경우는
 * 전부 `unverified`로 남는다(읽기 전용 분석 결과 §4/§5/§7 참고). 기존 won(퍼센트/월 정액)
 * 경로는 별도 분기라 이 describe 블록의 어떤 케이스도 건드리지 않는다.
 */
describe("normalizeCard() — 단위 기반(포인트/마일리지) reward 정규화", () => {
  it("A. 단순 마일 — programName이 줄 맨 앞에 명확하면 parsed", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "항공마일리지",
        benefitSummary: "대한항공 1,500원당 1마일리지",
        descriptionLines: ["대한항공 1,500원당 1마일리지 적립"],
      }),
    );
    const reward = piece.kind === "spendingBenefit" ? piece.reward : null;
    assert.equal(reward?.status, "parsed");
    if (reward?.status !== "parsed" || reward.value.kind !== "rate") throw new Error("unreachable");
    assert.equal(reward.value.currency.status, "parsed");
    assert.deepEqual(reward.value.currency.status === "parsed" ? reward.value.currency.value : null, {
      type: "miles",
      programName: "대한항공",
      valuation: null,
      unit: { unitAmount: 1500, quantityPerUnit: 1 },
    });
  });

  it("B. 단순 포인트 — 동일 모델로 포인트도 parsed", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "포인트/캐시백",
        benefitSummary: "신세계 1,000원당 5포인트",
        descriptionLines: ["신세계 1,000원당 5포인트 적립"],
      }),
    );
    const reward = piece.kind === "spendingBenefit" ? piece.reward : null;
    assert.equal(reward?.status, "parsed");
    if (reward?.status !== "parsed" || reward.value.kind !== "rate") throw new Error("unreachable");
    assert.deepEqual(reward.value.currency.status === "parsed" ? reward.value.currency.value : null, {
      type: "points",
      programName: "신세계",
      valuation: null,
      unit: { unitAmount: 1000, quantityPerUnit: 5 },
    });
  });

  it("C. comma 없는 숫자도 동일하게 parsed", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "항공마일리지",
        benefitSummary: "스카이패스 1500원당 1마일",
        descriptionLines: ["스카이패스 1500원당 1마일 적립"],
      }),
    );
    const reward = piece.kind === "spendingBenefit" ? piece.reward : null;
    assert.equal(reward?.status, "parsed");
    if (reward?.status !== "parsed" || reward.value.kind !== "rate") throw new Error("unreachable");
    assert.deepEqual(reward.value.currency.status === "parsed" ? reward.value.currency.value : null, {
      type: "miles",
      programName: "스카이패스",
      valuation: null,
      unit: { unitAmount: 1500, quantityPerUnit: 1 },
    });
  });

  it("D. 소수 quantity('1.5마일')는 parsed 금지 — RewardUnit.quantityPerUnit이 정수 모델이므로 변환하지 않는다", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "항공마일리지",
        benefitSummary: "대한항공 1,500원당 1.5마일",
        descriptionLines: ["대한항공 1,500원당 1.5마일 적립"],
      }),
    );
    const reward = piece.kind === "spendingBenefit" ? piece.reward : null;
    assert.notEqual(reward?.status, "parsed");
  });

  it("E. '최대' 수식어가 붙으면 고정 rate로 만들지 않는다 — parsed 금지", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "항공마일리지",
        benefitSummary: "대한항공 1,500원당 최대 2마일",
        descriptionLines: ["대한항공 1,500원당 최대 2마일 적립"],
      }),
    );
    const reward = piece.kind === "spendingBenefit" ? piece.reward : null;
    assert.notEqual(reward?.status, "parsed");
  });

  it("F. programName이 전혀 없으면 추측하지 않고 unverified(PROGRAM_NAME_NOT_FOUND)로 남긴다", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "항공마일리지",
        benefitSummary: "국내 이용금액 1,500원당 1마일리지 적립",
        descriptionLines: ["국내 이용금액 1,500원당 1마일리지 적립"],
      }),
    );
    const reward = piece.kind === "spendingBenefit" ? piece.reward : null;
    assert.equal(reward?.status, "unverified");
    assert.equal(reward?.status === "unverified" ? reward.reasonCode : null, "PROGRAM_NAME_NOT_FOUND");
  });

  it("G. 브랜드가 수량보다 먼저 오는 어순('1,500원당 대한항공 1마일리지')은 이번 단계에서 parsed 금지", () => {
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "항공마일리지",
        benefitSummary: "1,500원당 대한항공 1마일리지",
        descriptionLines: ["1,500원당 대한항공 1마일리지 적립"],
      }),
    );
    const reward = piece.kind === "spendingBenefit" ? piece.reward : null;
    assert.notEqual(reward?.status, "parsed");
  });

  it("H. 다중 rate regression(card_ad_id=1312 KB국민 마일리지 가온카드 실제 원문) — 첫 번째 match를 선택하지 않고 unverified로 남기며, target=overseas와 잘못 결합되지 않는다", () => {
    // 실제 CSV 원문 그대로: 한 row의 benefit_summary에 국내(1마일)/해외(2마일) 서로 다른
    // unit rate가 "|"로 함께 있다. 이 row의 target은(별개 로직인 detectTarget()에 의해)
    // "해외" 단독 언급 때문에 categories:["overseas"]로 이미 parsed된다 — reward가 첫
    // 매치(국내 1마일)를 그대로 채택하면 "target=해외인데 amount=국내 1마일"이라는, 원문에
    // 없는 조합이 만들어진다. reward 자체가 parsed가 되지 않아야 이 위험이 원천 차단된다.
    const piece = normalizeSingleSpendingPiece(
      buildRawBenefit({
        benefitCategory: "항공마일리지",
        benefitSummary: "국내가맹점 1,500원당 1마일 적립 | 해외가맹점 1,500원당 2마일 적립",
        descriptionLines: [
          "국내 가맹점 이용 시 일시불 및 할부 이용금액 1,500원 당 대한항공 1마일리지 적립",
          "해외 이용 시(직구, 온라인 포함) 일시불 및 할부 이용금액 1,500원 당 대한항공 2마일리지 적립",
        ],
      }),
    );
    assert.equal(piece.kind, "spendingBenefit");
    if (piece.kind !== "spendingBenefit") throw new Error("unreachable");

    // target은 기존(수정하지 않은) detectTarget() 로직 그대로 overseas로 판정된다 —
    // reward parser가 이 판정에 관여하거나 바꾸지 않았음을 함께 확인한다.
    assert.equal(piece.target.status, "parsed");
    assert.deepEqual(piece.target.status === "parsed" ? piece.target.value : null, {
      type: "categories",
      categories: ["overseas"],
    });

    // reward는 반드시 미적용(unverified)이어야 하며, 첫 매치(국내 1마일)를 골라선 안 된다.
    assert.notEqual(piece.reward.status, "parsed");
    assert.equal(piece.reward.status === "unverified" ? piece.reward.reasonCode : null, "MULTIPLE_CONFLICTING_VALUES");

    // 이 piece는 target은 parsed, reward는 unverified이므로 전체 piece는 fully-parsed가
    // 아니다 — 최종 domain SpendingBenefit이 만들어지지 않는 기존 파이프라인 동작(1단계 6번
    // 원칙)과 일치한다.
    const allParsed = [piece.name, piece.requiredTierId, piece.target, piece.minMonthlySpend, piece.reward, piece.limits, piece.sharedCapId].every(
      (o) => o.status === "parsed",
    );
    assert.equal(allParsed, false);
  });
});
