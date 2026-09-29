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
