<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# CardValue

## Project Overview

CardValue는 사용자의 월별 소비 패턴을 기반으로 신용카드의 실제 예상 혜택을 계산하고,
사용자에게 적합한 카드를 추천하는 서비스입니다.

단순히 카드의 최대 할인율이나 적립률을 비교하지 않고,
연회비, 전월실적, 혜택 한도, 할인/적립 조건, 기프트 등의 조건을 실제 소비 패턴에 적용하여
예상 순혜택을 계산하는 것을 핵심으로 합니다.

## Tech Stack

- Next.js 16 App Router
- TypeScript
- React
- Tailwind CSS
- Supabase
- PostgreSQL
- Vercel

Next.js의 API, 규칙, 파일 구조는 현재 설치된 버전을 기준으로 판단한다.
코드를 작성하기 전에 필요한 경우 `node_modules/next/dist/docs/`의 관련 문서를 확인한다.

## Development Principles

1. **비즈니스 로직과 UI를 분리한다.**
   - React 컴포넌트는 화면 표시와 사용자 인터랙션을 담당한다.
   - 추천 계산, 카드 조건 판단, 혜택 계산 등의 비즈니스 로직은 UI 컴포넌트에 직접 작성하지 않는다.

2. **추천 로직은 순수 함수 중심으로 작성한다.**
   - 동일한 입력에 대해 동일한 결과를 반환하도록 설계한다.
   - 가능한 경우 외부 상태나 React 의존성을 추천 계산 로직에서 제거한다.

3. **추천 관련 로직은 `src/lib/recommendation/`에서 관리한다.**
   - 카드 자격 조건 판단
   - 혜택 계산
   - 순혜택 계산
   - 추천 결과 정렬
   등의 로직을 해당 디렉터리에서 관리한다.

4. **TypeScript 타입을 적극적으로 사용한다.**
   - 데이터 구조와 함수의 입력/출력을 명확하게 정의한다.
   - 특별한 이유가 없는 한 `any`를 사용하지 않는다.
   - 타입 오류를 무시하기 위해 `@ts-ignore` 등을 사용하지 않는다.

5. **카드의 최대 혜택이 아닌 실제 예상 혜택을 계산한다.**
   - 사용자의 소비 패턴을 기준으로 실제 적용 가능한 혜택만 계산한다.
   - 전월실적, 혜택 한도, 최소 사용 금액, 제외 조건 등을 계산에 반영한다.

6. **추천 계산 과정은 추적 가능해야 한다.**
   - 최종 추천 결과만 반환하기보다 어떤 조건과 혜택이 적용되었는지 확인할 수 있는 구조를 선호한다.
   - 사용자가 추천 결과의 근거를 이해할 수 있도록 계산 결과에 필요한 정보를 보존한다.

7. **카드 조건과 계산 로직을 분리한다.**
   - 연회비, 전월실적, 할인율, 적립률, 혜택 한도 등의 카드 데이터와
     해당 데이터를 계산하는 로직을 하나의 코드에 하드코딩하지 않는다.
   - 카드 데이터가 변경되어도 계산 로직을 불필요하게 수정하지 않아도 되는 구조를 우선한다.

8. **서버와 클라이언트의 책임을 명확하게 구분한다.**
   - 서버 전용 데이터와 secret을 클라이언트에 노출하지 않는다.
   - Supabase의 service role key와 같은 서버 전용 인증 정보는 서버 환경에서만 사용한다.
   - `NEXT_PUBLIC_` 환경변수에는 공개되어도 되는 값만 사용한다.

9. **관련 없는 코드를 함께 수정하지 않는다.**
   - 현재 작업에 필요한 최소 범위만 변경한다.
   - 기존 동작을 유지하면서 필요한 부분만 수정한다.
   - 단순한 스타일 변경이나 대규모 리팩터링을 기능 변경과 함께 수행하지 않는다.

10. **변경 범위가 큰 작업은 구현 전에 계획을 세운다.**
    - 여러 파일이나 디렉터리에 영향을 주는 변경은 먼저 변경 대상과 책임을 정리한다.
    - 기존 구조를 확인한 후 새로운 추상화나 디렉터리를 추가한다.
    - 필요하지 않은 추상화는 만들지 않는다.

11. **추천 로직은 테스트 가능하도록 작성한다.**
    - 추천 계산과 같은 핵심 비즈니스 로직에는 테스트를 작성한다.
    - 특히 경계값과 예외적인 조건을 테스트한다.
    - 현재 테스트 러너는 별도로 설정되어 있지 않으므로 테스트 러너 선택 및 설치는 별도의 작업으로 진행한다.

## Recommendation Pipeline

추천은 다음과 같은 단계로 처리한다.

```text
사용자 소비 패턴 입력
        ↓
카드 후보 필터링
        ↓
카드 혜택 조건 확인
        ↓
전월실적 조건 확인
        ↓
카테고리별 혜택 계산
        ↓
혜택 한도 및 제외 조건 적용
        ↓
연간/부가 혜택 계산
        ↓
연회비 반영
        ↓
예상 순혜택 계산
        ↓
추천 결과 생성 및 정렬
```

## Domain Design Decisions

CardValue 추천 도메인의 설계 결정사항이다. 타입과 계산 로직은 아래 결정을 전제로 작성한다.

### 금액, 요율, 반올림

1. **금액은 정수 KRW로 표현한다.**
   - 금액에 floating point를 사용하지 않는다.
   - 필요하다면 `Won` branded type을 사용한다.

2. **혜택 요율은 basis point 정수로 표현한다.**
   - `500 = 5%`, `1000 = 10%`
   - 계산 과정에서 floating point 기반 금액 계산을 피한다.

3. **반올림은 계산 엔진 내부의 명확한 한 지점(`rounding.ts`)에서 처리한다.**
   - 기본 정책은 혜택 단위 내림(floor)이다.
   - 실제 카드사의 건별 계산과 차이가 발생할 수 있으므로, 적용한 반올림 정책을 계산 결과의 `assumptions`에 남길 수 있어야 한다.

### 입력과 비교 기준

4. **`MonthlySpending`은 `previousMonth`와 현재 월 소비 데이터를 명시적으로 분리한다.**
   - 계산 엔진은 전월실적을 현재 월 소비와 임의로 동일하다고 간주하지 않는다.

5. **혜택 간 중복 및 통합 한도의 적용 순서는 결정적이어야 한다.**
   - `priority` 등의 데이터 필드로 순서를 명시한다.
   - 같은 입력에 대해 항상 같은 결과가 나와야 한다.

6. **1차 버전의 소비 카테고리는 TypeScript union으로 관리한다.**
   - 가맹점 단위 혜택은 1차 구현에서 지원하지 않는다.
   - 필요해질 경우 추후 확장한다.

7. **추천 가치의 기본 비교 단위는 연간이다.**
   - 1개월 소비 패턴을 기준으로 월 혜택을 계산한 뒤 `monthlyBenefit * 12`로 연간 가치를 환산한다.

8. **연회비는 연간 순혜택에서 차감한다.**

### 부가 혜택과 포인트

9. **라운지, 기프트, 바우처 등 부가 혜택은 일반 소비 혜택 계산과 분리한다.**
   - 사용 여부 또는 실제 가치 환산 여부를 나중에 사용자 선택으로 확장할 수 있도록 설계한다.
   - 100% 가치가 실현된다고 임의로 가정하지 않는다.

10. **포인트/마일리지의 원화 환산은 명시적인 환산 계수와 출처를 가져야 한다.**
    - 임의의 `1P = 1원` 가정을 기본값으로 사용하지 않는다.

### 데이터 출처와 결과

11. **카드 데이터 출처는 도메인 모델에서 최소한 `sourceUrl`, `verifiedAt`을 추적할 수 있어야 한다.**
    - 원본 raw 데이터는 향후 DB 저장 영역에서 관리하며, 도메인 모델에는 포함하지 않는다.

12. **계산 trace의 사유는 자유 문자열이 아니라 구조화된 reason code를 사용한다.**
    - 사용자에게 보여줄 문구는 UI 계층에서 생성한다.

13. **순혜택이 음수가 되는 것은 유효한 계산 결과로 허용한다.**

14. **핵심 카드 조건이 검증되지 않은 카드는 다음과 같이 처리한다.**
    - 계산 가능한 부분은 `warnings`와 함께 계산할 수 있다.
    - 핵심 조건을 검증할 수 없어 결과의 신뢰성이 확보되지 않는 경우에는 추천 대상에서 제외할 수 있어야 한다.

## File Structure

초기 구현은 다음과 같이 단순한 구조를 사용한다.

```text
src/lib/recommendation/
├── types/
│   ├── money.ts
│   ├── category.ts
│   ├── card.ts
│   ├── benefit.ts
│   ├── spending.ts
│   ├── calculation.ts
│   ├── result.ts
│   └── index.ts
├── eligibility.ts
├── rewards.ts
├── calculator.ts
├── ranking.ts
├── rounding.ts
└── index.ts
```

- `eligibility`, `rewards`, `calculator`, `ranking`은 초기에는 단일 파일로 유지한다.
- 파일의 복잡도가 실제로 증가할 때만 디렉터리로 분리한다.
- `src/lib/recommendation/`은 Supabase나 React에 의존하지 않는 순수 모듈로 유지한다. DB 조회와 DB 행 → 도메인 모델 변환은 이 디렉터리 밖에서 처리한다.
