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
