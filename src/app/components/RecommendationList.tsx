"use client";

import { useState } from "react";
import type { RankedCard } from "../../lib/recommendation/types";
import type { BenefitDisplayInfo, TierDisplayInfo } from "./SpendingForm";
import RecommendationCard from "./RecommendationCard";

interface RecommendationListProps {
  readonly ranked: readonly RankedCard[];
  readonly cardInfo: Readonly<Record<string, { name: string; issuer: string }>>;
  readonly benefitInfo: Readonly<Record<string, BenefitDisplayInfo>>;
  readonly tierInfo: Readonly<Record<string, TierDisplayInfo>>;
}

/** 처음에 보여줄 카드 수. 나머지는 "더 많은 추천 카드 보기"로 펼친다 — ranking 자체는
 * 여전히 `ranked`(백엔드가 전체를 계산·정렬한 결과) 그대로이고, 이 값은 화면 표시 개수만
 * 제한하는 순수 UI 상태다. */
const INITIAL_VISIBLE_COUNT = 5;

/** `ranked` 순서 그대로 렌더링한다 — 이미 정렬돼 있는 API 결과를 다시 정렬하지 않는다.
 * 선택된 카드 ID는 이 목록이 소유한다 — 카드를 새로 선택하면 이전에 펼쳐둔 상세는 접힌다
 * (한 번에 하나만 펼쳐지는 아코디언 동작). 새 routing/페이지는 만들지 않는다. */
export default function RecommendationList({ ranked, cardInfo, benefitInfo, tierInfo }: RecommendationListProps) {
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (ranked.length === 0) {
    return (
      <p className="rounded-2xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        조건에 맞는 추천 결과가 없습니다.
      </p>
    );
  }

  const hasMore = ranked.length > INITIAL_VISIBLE_COUNT;
  const visibleRanked = showAll ? ranked : ranked.slice(0, INITIAL_VISIBLE_COUNT);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">내 소비 패턴을 기준으로 {ranked.length}개 카드를 비교했어요.</p>
      <div className="space-y-3">
        {visibleRanked.map((rankedCard) => (
          <RecommendationCard
            key={rankedCard.result.cardId}
            rank={rankedCard.rank}
            result={rankedCard.result}
            card={cardInfo[rankedCard.result.cardId]}
            benefitInfo={benefitInfo}
            tierInfo={tierInfo}
            expanded={selectedCardId === rankedCard.result.cardId}
            onToggleExpanded={() =>
              setSelectedCardId((current) => (current === rankedCard.result.cardId ? null : rankedCard.result.cardId))
            }
          />
        ))}
      </div>

      {hasMore && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3.5 text-sm font-medium text-blue-600"
        >
          {showAll ? "추천 카드 접기" : "더 많은 추천 카드 보기"}
        </button>
      )}
    </div>
  );
}
