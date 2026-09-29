import { NextResponse } from "next/server";
import { recommendCards } from "../../../lib/recommendation";
import { validateMonthlySpending } from "../../../lib/recommendation/validation";
import type { CalculationAssumptions } from "../../../lib/recommendation/types/calculation";
import type { MonthlySpending } from "../../../lib/recommendation/types/spending";
import type { Card, CategoryTarget, RewardCurrency } from "../../../lib/recommendation/types";
import { DbQueryError, loadCards } from "../../../lib/db/loadCards";
import { DbMapperError } from "../../../lib/db/mapper";

/**
 * POST /api/recommendations
 *
 * 처리 순서: request body → JSON parse → validateMonthlySpending() → loadCards() →
 * recommendCards(cards, spending, assumptions) → JSON response.
 *
 * `CalculationAssumptions`는 이 파일이 기본값을 만들지 않는다 — body.assumptions를 그대로
 * `recommendCards()`에 전달한다(recommendation/index.ts 자체가 이미 "assumptions를 대신
 * 만들지 않는다"고 선언하고 있고, 이 API도 그 원칙을 그대로 따른다).
 *
 * service role key는 `loadCards()` 내부(`src/lib/db/client.ts`)에서만 쓰이고, 이 파일이나
 * 응답/로그에 직접 등장하지 않는다.
 */

interface RecommendationRequestBody {
  readonly spending?: unknown;
  readonly assumptions?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `benefitCalculations[].benefitId` / `perkCalculations[].perkId`를 실제 혜택 이름·대상
 * 카테고리로 연결하기 위한 표시용 정보. `SpendingBenefit`/`PerkBenefit` 정의 필드를 그대로
 * 옮긴 것이며 새로 계산하지 않는다. `target`은 `CategoryTarget`을 그대로 사용한다(임의로
 * 평탄화한 문자열 배열을 만들지 않는다). perk는 대상 카테고리 개념이 없으므로 `target`이 없다.
 */
type BenefitDisplayInfo =
  | { kind: "rate"; name: string; target: CategoryTarget; rateBps: number; currency: RewardCurrency }
  | { kind: "fixed"; name: string; target: CategoryTarget; monthlyAmount: number }
  | { kind: "perk"; name: string };

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 올바른 JSON이 아닙니다." }, { status: 400 });
  }

  const { spending, assumptions }: RecommendationRequestBody = isPlainObject(body) ? body : {};

  // validateMonthlySpending()은 spending이 없거나 형태가 잘못돼도(undefined 포함) 스스로
  // MISSING_FIELD 등의 ValidationIssue로 보고한다 — 여기서 별도의 "필드가 없습니다" 같은
  // 새 validation 규칙을 만들지 않고 기존 함수에 그대로 위임한다.
  const spendingValidation = validateMonthlySpending(spending as MonthlySpending);
  if (!spendingValidation.valid) {
    // 기존 ValidationResult(errors/warnings)를 그대로 반환한다 — 새 에러 스키마를 만들지 않는다.
    return NextResponse.json(spendingValidation, { status: 400 });
  }

  let cards: readonly Card[];
  try {
    cards = await loadCards();
  } catch (error) {
    if (error instanceof DbMapperError) {
      console.error("recommendations API: DB row -> Domain Card 매핑 실패", error);
    } else if (error instanceof DbQueryError) {
      console.error("recommendations API: Supabase 조회 실패", error);
    } else {
      console.error("recommendations API: 카드 데이터 로딩 중 알 수 없는 오류", error);
    }
    // DB/service-role 관련 상세 정보는 응답에 포함하지 않는다.
    return NextResponse.json({ error: "카드 데이터를 불러오지 못했습니다." }, { status: 500 });
  }

  try {
    const result = recommendCards(cards, spendingValidation.value, assumptions as CalculationAssumptions);

    // RecommendationResult(input/ranked/excluded/assumptions)는 그대로 반환한다 — 축약하거나
    // 새 response schema로 감싸지 않는다. ranked가 빈 배열이거나 excluded에 카드가 있어도
    // 이는 정상적인 계산 결과이므로 200이다.
    //
    // cardInfo/benefitInfo/tierInfo는 모두 같은 방식이다: 이미 로딩된 `cards` 배열(=
    // `recommendCards()`에 그대로 넘긴 것)을 순회해 표시용 필드만 뽑는다. 추가 DB 조회나
    // 새 계산이 없고, `ranked`뿐 아니라 `excluded`의 cardId/benefitId도 같은 맵에서
    // 찾을 수 있도록 전체 `cards` 기준으로 만든다.
    const cardInfo: Record<string, { name: string; issuer: string }> = {};
    const benefitInfo: Record<string, BenefitDisplayInfo> = {};
    const tierInfo: Record<string, { name: string; minPreviousMonthSpend: number }> = {};

    for (const card of cards) {
      cardInfo[card.id] = { name: card.name, issuer: card.issuer };

      for (const benefit of card.spendingBenefits) {
        benefitInfo[benefit.id] =
          benefit.kind === "rate"
            ? { kind: "rate", name: benefit.name, target: benefit.target, rateBps: benefit.rateBps, currency: benefit.currency }
            : { kind: "fixed", name: benefit.name, target: benefit.target, monthlyAmount: benefit.monthlyAmount };
      }
      for (const perk of card.perks) {
        benefitInfo[perk.id] = { kind: "perk", name: perk.name };
      }

      for (const tier of card.performanceTiers) {
        tierInfo[tier.id] = { name: tier.name, minPreviousMonthSpend: tier.minPreviousMonthSpend };
      }
    }

    return NextResponse.json({ ...result, cardInfo, benefitInfo, tierInfo }, { status: 200 });
  } catch (error) {
    console.error("recommendations API: recommendCards 실행 중 오류", error);
    return NextResponse.json({ error: "추천 계산 중 오류가 발생했습니다." }, { status: 500 });
  }
}
