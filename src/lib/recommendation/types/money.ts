declare const brand: unique symbol;

/** 구조적으로 같은 원시 타입끼리 섞이지 않도록 하는 명목적 타입 표시. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * 정수 KRW. 소수를 허용하지 않으며 음수는 순혜택처럼 유효한 결과에서만 나타난다.
 *
 * 이 파일은 primitive branded type 정의만 담당한다.
 * 런타임 값/구조/참조 검증은 `validation.ts`, 계산 중 반올림/버림은 `rounding.ts`의 책임이다.
 */
export type Won = Brand<number, "Won">;

/** 요율(basis point 정수). `500` = 5%, `1000` = 10%, `10000` = 100%. */
export type BasisPoints = Brand<number, "BasisPoints">;

/**
 * 포인트/마일리지 적립 수량. 원화 환산 없이 프로그램 고유 단위 그대로의 개수다.
 * 0 이상의 안전한 정수. 원화(`Won`)와 구조적으로 섞이지 않도록 별도 brand를 쓴다.
 */
export type RewardQuantity = Brand<number, "RewardQuantity">;
