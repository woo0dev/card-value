declare const brand: unique symbol;

/** 구조적으로 같은 원시 타입끼리 섞이지 않도록 하는 명목적 타입 표시. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * 정수 KRW. 소수를 허용하지 않으며 음수는 순혜택처럼 유효한 결과에서만 나타난다.
 * 값 생성과 검증은 계산 엔진(`rounding.ts`)의 책임이다.
 */
export type Won = Brand<number, "Won">;

/** 요율(basis point 정수). `500` = 5%, `1000` = 10%, `10000` = 100%. */
export type BasisPoints = Brand<number, "BasisPoints">;
