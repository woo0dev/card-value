import { SPENDING_CATEGORIES } from "./types/category";
import type { Card } from "./types/card";
import type { MonthlySpending } from "./types/spending";
import type {
  ValidatedCard,
  ValidationErrorCode,
  ValidationIssue,
  ValidationIssueContext,
  ValidationPath,
  ValidationResult,
  ValidationWarningCode,
} from "./types/validation";

/**
 * 런타임 데이터 검증. 데이터가 계산 가능한 구조인지만 확인하며 어떤 계산도 하지 않는다
 * (`achievedTier`, 배타 그룹 승자, 통합 한도 소진, 혜택 금액 등은 여기서 다루지 않는다).
 *
 * 검사 결과는 검사 순서에 의존하지 않는다. 참조 대상 집합은 먼저 모두 만든 뒤 대조하고,
 * 중복은 처음이든 나중이든 관련된 항목 모두에 보고하며, 최종 이슈 목록은 정렬해서 반환한다.
 */

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set<string>(SPENDING_CATEGORIES);

const SPENDING_PERIODS = ["previousMonth", "currentMonth"] as const;

// ---------------------------------------------------------------------------
// 이슈 생성 / 결과 조립
// ---------------------------------------------------------------------------

function error(
  code: ValidationErrorCode,
  path: ValidationPath,
  context?: ValidationIssueContext,
): ValidationIssue {
  return context === undefined
    ? { code, severity: "error", path }
    : { code, severity: "error", path, context };
}

function warning(
  code: ValidationWarningCode,
  path: ValidationPath,
  context?: ValidationIssueContext,
): ValidationIssue {
  return context === undefined
    ? { code, severity: "warning", path }
    : { code, severity: "warning", path, context };
}

function compareIssues(a: ValidationIssue, b: ValidationIssue): number {
  const pathA = a.path.join("/");
  const pathB = b.path.join("/");
  if (pathA !== pathB) return pathA < pathB ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return 0;
}

function splitIssues(issues: readonly ValidationIssue[]): {
  errors: readonly ValidationIssue[];
  warnings: readonly ValidationIssue[];
} {
  const sorted = [...issues].sort(compareIssues);
  return {
    errors: sorted.filter((issue) => issue.severity === "error"),
    warnings: sorted.filter((issue) => issue.severity === "warning"),
  };
}

function hasIssues(
  issues: readonly ValidationIssue[],
): issues is readonly [ValidationIssue, ...ValidationIssue[]] {
  return issues.length > 0;
}

// ---------------------------------------------------------------------------
// 값 검증 (primitive)
// ---------------------------------------------------------------------------

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/** 이슈 context에 담을 값. 어떤 외부 값이 와도 예외 없이 number 또는 string으로 바꾼다. */
function contextValue(value: unknown): number | string {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return typeof value === "object" && value !== null ? "[object]" : String(value);
}

/** `Won` 값 자체의 조건: 안전한 정수. 음수 여부는 검사하지 않는다. */
export function validateWon(value: unknown, path: ValidationPath): readonly ValidationIssue[] {
  return isSafeInt(value)
    ? []
    : [error("NOT_SAFE_INTEGER", path, { value: contextValue(value) })];
}

/** 소비액, 실적 하한, 혜택 금액, 한도, 연회비처럼 0 이상이어야 하는 `Won`. */
function validateNonNegativeWon(value: unknown, path: ValidationPath): readonly ValidationIssue[] {
  if (!isSafeInt(value)) return [error("NOT_SAFE_INTEGER", path, { value: contextValue(value) })];
  return value < 0 ? [error("NEGATIVE_VALUE", path, { value })] : [];
}

/** 한도: `null`은 한도 없음, `0`은 한도 0이며 둘 다 유효하다. */
function validateNullableNonNegativeWon(
  value: unknown,
  path: ValidationPath,
): readonly ValidationIssue[] {
  return value === null ? [] : validateNonNegativeWon(value, path);
}

/**
 * `BasisPoints`: 안전한 정수이며 음수 불가. 0은 허용한다.
 * 상한은 기본적으로 없고, `realizationBps`처럼 필요한 곳에서 `max`(예: 10000)를 지정한다.
 */
export function validateBasisPoints(
  value: unknown,
  path: ValidationPath,
  options: { readonly max?: number } = {},
): readonly ValidationIssue[] {
  if (!isSafeInt(value)) return [error("NOT_SAFE_INTEGER", path, { value: contextValue(value) })];
  if (value < 0) return [error("NEGATIVE_VALUE", path, { value })];
  if (options.max !== undefined && value > options.max) {
    return [error("OUT_OF_RANGE", path, { value })];
  }
  return [];
}

/** `priority`: 유한한 수이면 충분하다. 음수, 소수, 중복 모두 허용한다. */
function validatePriority(value: unknown, path: ValidationPath): readonly ValidationIssue[] {
  return typeof value === "number" && Number.isFinite(value)
    ? []
    : [error("NOT_FINITE", path, { value: contextValue(value) })];
}

// ---------------------------------------------------------------------------
// 구조 검증 helper
// ---------------------------------------------------------------------------

function at(path: ValidationPath, ...segments: (string | number)[]): ValidationPath {
  return [...path, ...segments];
}

/** 배열이 아니면 `MISSING_FIELD`를 기록하고 빈 배열을 돌려준다. */
function arrayOrMissing<T>(
  value: readonly T[],
  path: ValidationPath,
  issues: ValidationIssue[],
): readonly T[] {
  if (Array.isArray(value)) return value;
  issues.push(error("MISSING_FIELD", path));
  return [];
}

/** 원래 배열에서의 위치를 유지한 원소. */
interface IndexedItem<T> {
  item: T;
  index: number;
}

/**
 * 배열의 객체 원소만 원래 인덱스와 함께 돌려준다. 원소가 `null`, `undefined`, 빈 슬롯, 원시값, 배열이면
 * 해당 위치에 `MISSING_FIELD`를 기록하고 건너뛰어서, 이후 검사가 원소 접근 중 예외를 내지 않게 한다.
 */
function presentElements<T>(
  value: readonly T[],
  path: ValidationPath,
  issues: ValidationIssue[],
): readonly IndexedItem<T>[] {
  const array = arrayOrMissing(value, path, issues);
  const present: IndexedItem<T>[] = [];
  for (let index = 0; index < array.length; index++) {
    const item = array[index];
    if (isObject(item)) present.push({ item, index });
    else issues.push(error("MISSING_FIELD", at(path, index)));
  }
  return present;
}

interface KeyedPath {
  key: string | number | undefined;
  path: ValidationPath;
}

/** 같은 키를 가진 항목이 둘 이상이면 관련된 항목 전부에 이슈를 만든다. `undefined` 키는 건너뛴다. */
function duplicateIssues(entries: readonly KeyedPath[], code: ValidationErrorCode): ValidationIssue[] {
  const groups = new Map<string | number, ValidationPath[]>();
  for (const { key, path } of entries) {
    if (key === undefined) continue;
    const paths = groups.get(key);
    if (paths) paths.push(path);
    else groups.set(key, [path]);
  }

  const issues: ValidationIssue[] = [];
  for (const [key, paths] of groups) {
    if (paths.length < 2) continue;
    for (const path of paths) {
      issues.push(error(code, path, typeof key === "string" ? { id: key } : { value: key }));
    }
  }
  return issues;
}

function validateCategoryList(
  categories: readonly string[],
  path: ValidationPath,
  issues: ValidationIssue[],
): void {
  const array = arrayOrMissing(categories, path, issues);
  for (let index = 0; index < array.length; index++) {
    const category = array[index];
    if (typeof category !== "string" || !KNOWN_CATEGORIES.has(category)) {
      issues.push(
        error("UNKNOWN_SPENDING_CATEGORY", at(path, index), { id: String(contextValue(category)) }),
      );
    }
  }
}

function validateTierReference(
  tierId: string | null,
  tierIds: ReadonlySet<string>,
  path: ValidationPath,
  issues: ValidationIssue[],
): void {
  if (tierId !== null && !tierIds.has(tierId)) {
    issues.push(error("INVALID_TIER_REFERENCE", path, { id: contextValue(tierId).toString() }));
  }
}

function validatePointCurrency(
  currency: { readonly programName: string; readonly valuation: unknown },
  path: ValidationPath,
  issues: ValidationIssue[],
): void {
  if (isBlank(currency.programName)) {
    issues.push(error("EMPTY_STRING", at(path, "programName")));
  }

  const valuation = currency.valuation;
  if (!isObject(valuation)) {
    issues.push(error("MISSING_FIELD", at(path, "valuation")));
    return;
  }

  const valuationPath = at(path, "valuation", "wonPerThousandPoints");
  const wonPerThousandPoints = valuation.wonPerThousandPoints;
  if (!isSafeInt(wonPerThousandPoints)) {
    issues.push(
      error("NOT_SAFE_INTEGER", valuationPath, { value: contextValue(wonPerThousandPoints) }),
    );
  } else if (wonPerThousandPoints <= 0) {
    issues.push(error("NOT_POSITIVE", valuationPath, { value: wonPerThousandPoints }));
  }
}

// ---------------------------------------------------------------------------
// MonthlySpending
// ---------------------------------------------------------------------------

/**
 * 소비 입력 검증. `currentMonth`는 항상 있어야 하고, `previousMonth`는 객체이거나 `null`이어야
 * 한다(`null` = 전월 소비 미입력 → 전월실적 조건 충족으로 간주, `eligibility.ts` 참고).
 * 카테고리 금액은 0 이상의 안전한 정수여야 하며, 알 수 없는 카테고리 키는 오류다. `{}`는
 * 허용한다(모든 카테고리 0원으로 실제 입력한 상태 — `null`과 다르다).
 * 환불 등 음수 소비는 지원하지 않는다.
 */
export function validateMonthlySpending(
  spending: MonthlySpending,
): ValidationResult<MonthlySpending> {
  const issues: ValidationIssue[] = [];
  const input: unknown = spending;

  if (!isObject(input)) {
    issues.push(error("MISSING_FIELD", []));
  } else {
    for (const period of SPENDING_PERIODS) {
      const amounts = input[period];
      if (period === "previousMonth" && amounts === null) continue;
      if (!isObject(amounts)) {
        issues.push(error("MISSING_FIELD", [period]));
        continue;
      }
      for (const category of Object.keys(amounts)) {
        if (!KNOWN_CATEGORIES.has(category)) {
          issues.push(error("UNKNOWN_SPENDING_CATEGORY", [period, category], { id: category }));
          continue;
        }
        const amount = amounts[category];
        if (amount === undefined) continue;
        issues.push(...validateNonNegativeWon(amount, [period, category]));
      }
    }
  }

  const { errors, warnings } = splitIssues(issues);
  if (hasIssues(errors)) return { valid: false, errors, warnings };
  return { valid: true, value: spending, warnings };
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface ExclusiveGroupMember {
  index: number;
  tierKey: string;
  priority: number;
}

/**
 * 카드 데이터 검증: 값, 구간/통합한도 유일성, 참조 무결성, benefit id 유일성, 배타 그룹 경고.
 * 통과하면 `ValidatedCard`를 돌려준다. 이 브랜드는 여기 성공 분기에서만 만든다.
 *
 * 외부 데이터가 잘못되어도 예외를 던지지 않고 이슈로 반환한다. 배열 원소가 `null`/`undefined` 등
 * 객체가 아니면 `MISSING_FIELD`로 보고하고 해당 원소는 이후 검사에서 건너뛴다.
 */
export function validateCard(card: Card): ValidationResult<ValidatedCard> {
  const issues: ValidationIssue[] = [];
  const input: unknown = card;

  if (!isObject(input)) {
    issues.push(error("MISSING_FIELD", []));
  } else {
    collectCardIssues(card, issues);
  }

  const { errors, warnings } = splitIssues(issues);
  if (hasIssues(errors)) return { valid: false, errors, warnings };
  return { valid: true, value: card as ValidatedCard, warnings };
}

function collectCardIssues(card: Card, issues: ValidationIssue[]): void {
  // 카드 기본 값
  if (!isObject(card.annualFee)) {
    issues.push(error("MISSING_FIELD", ["annualFee"]));
  } else {
    issues.push(...validateNonNegativeWon(card.annualFee.amount, ["annualFee", "amount"]));
  }
  validateCategoryList(card.performanceExcludedCategories, ["performanceExcludedCategories"], issues);

  const tiers = presentElements(card.performanceTiers, ["performanceTiers"], issues);
  const sharedCaps = presentElements(card.sharedCaps, ["sharedCaps"], issues);
  const spendingBenefits = presentElements(card.spendingBenefits, ["spendingBenefits"], issues);
  const perks = presentElements(card.perks, ["perks"], issues);
  const unverifiedConditions = presentElements(
    card.unverifiedConditions,
    ["unverifiedConditions"],
    issues,
  );

  // 참조 대상 집합은 항목 검사보다 먼저 모두 만든다.
  const tierIds: ReadonlySet<string> = new Set<string>(tiers.map(({ item }) => item.id));
  const sharedCapIds: ReadonlySet<string> = new Set<string>(sharedCaps.map(({ item }) => item.id));
  // 소비 혜택과 부가 혜택 전체의 id (유일성 검사와 참조 대조에 사용).
  const benefitIdEntries: KeyedPath[] = [
    ...spendingBenefits.map(({ item, index }) => ({
      key: item.id,
      path: ["spendingBenefits", index, "id"],
    })),
    ...perks.map(({ item, index }) => ({ key: item.id, path: ["perks", index, "id"] })),
  ];
  const benefitIds: ReadonlySet<string> = new Set<string>(
    [...spendingBenefits, ...perks].map(({ item }) => item.id),
  );

  // performanceTiers: 배열 순서는 의미 없고, threshold 0과 빈 배열은 허용한다.
  for (const { item: tier, index } of tiers) {
    issues.push(
      ...validateNonNegativeWon(tier.minPreviousMonthSpend, [
        "performanceTiers",
        index,
        "minPreviousMonthSpend",
      ]),
    );
  }
  issues.push(
    ...duplicateIssues(
      tiers.map(({ item, index }) => ({ key: item.id, path: ["performanceTiers", index, "id"] })),
      "DUPLICATE_TIER_ID",
    ),
    ...duplicateIssues(
      tiers.map(({ item, index }) => ({
        key: isSafeInt(item.minPreviousMonthSpend) ? item.minPreviousMonthSpend : undefined,
        path: ["performanceTiers", index, "minPreviousMonthSpend"],
      })),
      "DUPLICATE_TIER_THRESHOLD",
    ),
  );

  // sharedCaps
  issues.push(
    ...duplicateIssues(
      sharedCaps.map(({ item, index }) => ({ key: item.id, path: ["sharedCaps", index, "id"] })),
      "DUPLICATE_SHARED_CAP_ID",
    ),
  );
  for (const { item: cap, index: capIndex } of sharedCaps) {
    const capPath: ValidationPath = ["sharedCaps", capIndex];
    issues.push(
      ...validateNonNegativeWon(cap.defaultMonthlyRewardCap, at(capPath, "defaultMonthlyRewardCap")),
    );
    const tierLimits = presentElements(cap.tierLimits, at(capPath, "tierLimits"), issues);
    for (const { item: limit, index: limitIndex } of tierLimits) {
      const limitPath = at(capPath, "tierLimits", limitIndex);
      issues.push(...validateNonNegativeWon(limit.monthlyRewardCap, at(limitPath, "monthlyRewardCap")));
      validateTierReference(limit.tierId, tierIds, at(limitPath, "tierId"), issues);
    }
    issues.push(
      ...duplicateIssues(
        tierLimits.map(({ item, index }) => ({
          key: item.tierId,
          path: at(capPath, "tierLimits", index, "tierId"),
        })),
        "DUPLICATE_TIER_LIMIT",
      ),
    );
  }

  // spendingBenefits
  const exclusiveGroups = new Map<string, ExclusiveGroupMember[]>();
  for (const { item: benefit, index } of spendingBenefits) {
    const path: ValidationPath = ["spendingBenefits", index];

    issues.push(...validatePriority(benefit.priority, at(path, "priority")));
    validateTierReference(benefit.requiredTierId, tierIds, at(path, "requiredTierId"), issues);
    if (benefit.sharedCapId !== null && !sharedCapIds.has(benefit.sharedCapId)) {
      issues.push(
        error("INVALID_SHARED_CAP_REFERENCE", at(path, "sharedCapId"), {
          id: contextValue(benefit.sharedCapId).toString(),
        }),
      );
    }
    issues.push(...validateNullableNonNegativeWon(benefit.minMonthlySpend, at(path, "minMonthlySpend")));

    const limits: unknown = benefit.limits;
    if (!isObject(limits)) {
      issues.push(error("MISSING_FIELD", at(path, "limits")));
    } else {
      issues.push(
        ...validateNullableNonNegativeWon(
          limits.monthlyRewardCap,
          at(path, "limits", "monthlyRewardCap"),
        ),
        ...validateNullableNonNegativeWon(
          limits.monthlyEligibleSpendCap,
          at(path, "limits", "monthlyEligibleSpendCap"),
        ),
      );
    }

    const target: unknown = benefit.target;
    if (!isObject(target)) {
      issues.push(error("MISSING_FIELD", at(path, "target")));
    } else {
      validateCategoryList(benefit.target.categories, at(path, "target", "categories"), issues);
    }

    switch (benefit.kind) {
      case "rate": {
        issues.push(...validateBasisPoints(benefit.rateBps, at(path, "rateBps")));
        const currency: unknown = benefit.currency;
        if (!isObject(currency)) {
          issues.push(error("MISSING_FIELD", at(path, "currency")));
        } else if (benefit.currency.type === "points") {
          validatePointCurrency(benefit.currency, at(path, "currency"), issues);
        }
        break;
      }
      case "fixed":
        issues.push(...validateNonNegativeWon(benefit.monthlyAmount, at(path, "monthlyAmount")));
        break;
    }

    // exclusiveGroupId: registry 없이 문자열 자체는 허용하되 빈 문자열/공백은 오류.
    if (benefit.exclusiveGroupId !== null) {
      if (isBlank(benefit.exclusiveGroupId)) {
        issues.push(error("EMPTY_STRING", at(path, "exclusiveGroupId")));
      } else {
        const members = exclusiveGroups.get(benefit.exclusiveGroupId) ?? [];
        members.push({
          index,
          tierKey: benefit.requiredTierId === null ? "none" : `tier:${benefit.requiredTierId}`,
          priority: benefit.priority,
        });
        exclusiveGroups.set(benefit.exclusiveGroupId, members);
      }
    }
  }

  // perks
  for (const { item: perk, index } of perks) {
    const path: ValidationPath = ["perks", index];
    validateTierReference(perk.requiredTierId, tierIds, at(path, "requiredTierId"), issues);
    switch (perk.kind) {
      case "voucher":
      case "gift":
        issues.push(...validateNonNegativeWon(perk.value, at(path, "value")));
        break;
      case "lounge":
        issues.push(...validateNonNegativeWon(perk.valuePerVisit, at(path, "valuePerVisit")));
        break;
      case "signupBonus": {
        issues.push(...validateNonNegativeWon(perk.value, at(path, "value")));
        const requirement: unknown = perk.requirement;
        if (requirement === undefined) {
          issues.push(error("MISSING_FIELD", at(path, "requirement")));
        } else if (requirement !== null) {
          if (!isObject(requirement)) {
            issues.push(error("MISSING_FIELD", at(path, "requirement")));
          } else {
            issues.push(
              ...validateNonNegativeWon(requirement.minSpend, at(path, "requirement", "minSpend")),
            );
          }
        }
        break;
      }
    }
  }

  // benefit id 유일성 (소비 혜택 + 부가 혜택 전체)
  issues.push(...duplicateIssues(benefitIdEntries, "DUPLICATE_BENEFIT_ID"));

  // unverifiedConditions 참조
  for (const { item: condition, index } of unverifiedConditions) {
    if (condition.benefitId !== null && !benefitIds.has(condition.benefitId)) {
      issues.push(
        error("INVALID_UNVERIFIED_BENEFIT_REFERENCE", ["unverifiedConditions", index, "benefitId"], {
          id: contextValue(condition.benefitId).toString(),
        }),
      );
    }
  }

  // 배타 그룹 경고: 계산은 id tie-breaker로 결정적이므로 error가 아니다.
  for (const [groupId, members] of exclusiveGroups) {
    const [only] = members;
    if (members.length === 1 && only) {
      issues.push(
        warning("EXCLUSIVE_GROUP_SINGLE_MEMBER", ["spendingBenefits", only.index, "exclusiveGroupId"], {
          id: groupId,
        }),
      );
      continue;
    }
    const sameOrder = new Map<string, ExclusiveGroupMember[]>();
    for (const member of members) {
      if (!Number.isFinite(member.priority)) continue;
      const key = `${member.tierKey}|${member.priority}`;
      sameOrder.set(key, [...(sameOrder.get(key) ?? []), member]);
    }
    for (const tied of sameOrder.values()) {
      if (tied.length < 2) continue;
      for (const member of tied) {
        issues.push(
          warning("EXCLUSIVE_GROUP_AMBIGUOUS_ORDER", ["spendingBenefits", member.index, "priority"], {
            id: groupId,
          }),
        );
      }
    }
  }
}
