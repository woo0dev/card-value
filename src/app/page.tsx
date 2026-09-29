"use client";

import { useState } from "react";
import SpendingForm, { type RecommendationApiResponse } from "./components/SpendingForm";
import RecommendationList from "./components/RecommendationList";

export default function Home() {
  const [result, setResult] = useState<RecommendationApiResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  return (
    <div className="min-h-full flex-1 bg-white">
      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold text-gray-900">CardValue</h1>
          <p className="text-base font-medium text-gray-800">나에게 맞는 카드를 찾아보세요.</p>
          <p className="text-sm leading-relaxed text-gray-500">
            지난달과 이번 달 소비를 입력하면 예상 혜택을 계산해 추천해드려요.
          </p>
        </header>

        <SpendingForm
          onResult={(data) => {
            setResult(data);
            setErrorMessage(null);
          }}
          onError={(message) => {
            setErrorMessage(message);
            setResult(null);
          }}
        />

        {errorMessage && (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
            {errorMessage}
          </p>
        )}

        {result && (
          <section className="space-y-4 border-t border-gray-100 pt-6">
            <h2 className="text-lg font-semibold text-gray-900">추천 카드</h2>
            <RecommendationList
              ranked={result.ranked}
              cardInfo={result.cardInfo}
              benefitInfo={result.benefitInfo}
              tierInfo={result.tierInfo}
            />
          </section>
        )}
      </main>
    </div>
  );
}
