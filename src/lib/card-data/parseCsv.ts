import type {
  RawBenefitDataset,
  RawBenefitRecord,
  RawCardDataset,
  RawCardRecord,
} from "./types";

/**
 * CSV 문자열 → Raw Record 파서.
 *
 * 이 파일은 CSV 문법만 처리한다 (comma, quoted field, quoted field 안의 comma,
 * escaped quote `""`, 빈 필드, CRLF/LF, 마지막 줄바꿈, BOM). 한국어 혜택 문장이나
 * JSON 컬럼의 내용을 해석하지 않는다 — 그것은 normalization 단계의 책임이다.
 *
 * 외부 CSV 파싱 라이브러리는 쓰지 않고, 아래 최소 상태 기계로 직접 처리한다.
 */

const BOM = "﻿";

/** 필드 값에서 빈 문자열만 `null`로 바꾼다. 이것은 CSV 구조 처리일 뿐, 값의 의미는 해석하지 않는다. */
function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/**
 * CSV 텍스트를 row(문자열 배열)의 배열로 나눈다. RFC 4180과 유사한 최소 구현이다.
 *
 * - 따옴표로 감싼 필드 안의 comma/줄바꿈은 필드 구분자로 취급하지 않는다.
 * - 따옴표 안의 `""`는 리터럴 `"` 하나로 바꾼다.
 * - `\r\n`, `\n`, (따옴표 밖의) 단독 `\r`을 모두 줄 구분자로 인정한다.
 * - 파일이 줄바꿈으로 끝나도 마지막에 빈 row가 추가로 생기지 않는다.
 * - 따옴표가 닫히지 않고 입력이 끝나면 오류를 던진다.
 */
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowStarted = false;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    rowStarted = false;
  };

  const length = text.length;
  let i = 0;
  while (i < length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      rowStarted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      rowStarted = true;
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    rowStarted = true;
    i += 1;
  }

  if (inQuotes) {
    throw new Error("CSV parse error: unterminated quoted field");
  }
  // 파일 끝에 줄바꿈이 있으면 그 다음엔 아무 내용도 없으므로 빈 row를 추가하지 않는다.
  // 줄바꿈 없이 파일이 끝났다면(또는 마지막 줄에 내용이 있다면) 그 row를 마저 채운다.
  if (rowStarted || field.length > 0) {
    endRow();
  }

  return rows;
}

/** 필드 키 → 실제 CSV 헤더 이름 매핑. 순서는 컬럼 존재 여부만 결정하고 위치는 쓰지 않는다. */
type FieldSpec<K extends string> = readonly (readonly [K, string])[];

interface ParsedRow<K extends string> {
  fields: Record<K, string | null>;
  raw: Readonly<Record<string, string | null>>;
}

/**
 * CSV 텍스트를 header 기준으로 구조화한다. column position(`row[0]` 등)에 의존하지 않고
 * `header.indexOf` 방식(헤더 이름 → 인덱스 맵)을 쓴다. 필수 헤더가 없으면 즉시 오류를 던진다.
 */
function parseDataset<K extends string>(
  csv: string,
  datasetName: string,
  fields: FieldSpec<K>,
  requiredNonEmptyKeys: readonly K[],
): ParsedRow<K>[] {
  const stripped = csv.startsWith(BOM) ? csv.slice(BOM.length) : csv;
  const rows = tokenizeCsv(stripped);
  if (rows.length === 0) {
    throw new Error(`${datasetName}: CSV input is empty (no header row found)`);
  }

  const [headerRow, ...dataRows] = rows;
  if (!headerRow) {
    throw new Error(`${datasetName}: CSV input is empty (no header row found)`);
  }

  const headerIndex = new Map<string, number>();
  headerRow.forEach((name, index) => {
    if (!headerIndex.has(name)) headerIndex.set(name, index);
  });

  const missingHeaders = fields
    .filter(([, header]) => !headerIndex.has(header))
    .map(([, header]) => header);
  if (missingHeaders.length > 0) {
    throw new Error(
      `${datasetName}: missing required CSV column(s): ${missingHeaders.join(", ")}`,
    );
  }

  const headerByKey = new Map<K, string>(fields);

  return dataRows.map((row, rowIndex) => {
    const cellByHeader = (header: string): string | null =>
      emptyToNull(row[headerIndex.get(header) as number]);

    const values = {} as Record<K, string | null>;
    for (const [key, header] of fields) {
      values[key] = cellByHeader(header);
    }

    for (const key of requiredNonEmptyKeys) {
      if (values[key] === null) {
        const header = headerByKey.get(key);
        // `dataRows`는 header row(1개)를 제외한 나머지이므로, CSV 파일에서의 실제 줄 번호는
        // header row(1줄) + 이전 데이터 row 수(rowIndex) + 1.
        const lineNumber = rowIndex + 2;
        throw new Error(
          `${datasetName}: missing required value for "${header}" at CSV line ${lineNumber}`,
        );
      }
    }

    const raw: Record<string, string | null> = {};
    headerRow.forEach((name, index) => {
      raw[name] = emptyToNull(row[index]);
    });

    return { fields: values, raw };
  });
}

type CardFieldKey = keyof Omit<RawCardRecord, "raw">;

const CARD_FIELDS: FieldSpec<CardFieldKey> = [
  ["cardAdId", "card_ad_id"],
  ["cardCode", "card_code"],
  ["cardName", "card_name"],
  ["issuerCode", "issuer_code"],
  ["issuerName", "issuer_name"],
  ["sourceUrl", "source_url"],
  ["issuerCardUrl", "issuer_card_url"],
  ["annualFeeDomestic", "annual_fee_domestic"],
  ["annualFeeInternational", "annual_fee_international"],
  ["annualFeeFamily", "family_annual_fee"],
  ["annualFeeDescription", "annual_fee_description"],
  ["minimumSpendFrom", "minimum_spend_from"],
  ["minimumSpendTo", "minimum_spend_to"],
  ["minimumSpendUnit", "minimum_spend_unit"],
  ["minimumSpendPeriod", "minimum_spend_period"],
  ["minimumSpendMethod", "minimum_spend_method"],
  ["minimumSpendDescription", "minimum_spend_description"],
  ["titleDescription", "title_description"],
  ["alertDescription", "alert_description"],
  ["benefitSummary", "benefit_summary"],
  ["newMemberBenefit", "new_member_benefit"],
  ["releaseDate", "release_at"],
  ["benefitCount", "benefit_count"],
  ["annualBrandFeesJson", "annual_brand_fees_json"],
  ["benefitNoticesJson", "benefit_notices_json"],
  ["extraDescJson", "extra_desc_json"],
  ["rateNoticesJson", "rate_notices_json"],
];

const CARD_REQUIRED_KEYS: readonly CardFieldKey[] = ["cardAdId", "cardName", "issuerName"];

type BenefitFieldKey = keyof Omit<RawBenefitRecord, "raw">;

const BENEFIT_FIELDS: FieldSpec<BenefitFieldKey> = [
  ["cardAdId", "card_ad_id"],
  ["cardName", "card_name"],
  ["issuerCode", "issuer_code"],
  ["issuerName", "issuer_name"],
  ["benefitOrder", "benefit_order"],
  ["benefitCategory", "benefit_category"],
  ["benefitCategoryId", "benefit_category_id"],
  ["benefitSummary", "benefit_summary"],
  ["benefitValuesJson", "benefit_values_json"],
  ["benefitDescriptionsJson", "benefit_descriptions_json"],
  ["benefitDescription", "benefit_description"],
  ["benefitIcon", "benefit_icon"],
];

const BENEFIT_REQUIRED_KEYS: readonly BenefitFieldKey[] = ["cardAdId", "benefitOrder"];

function toCardRecord(row: ParsedRow<CardFieldKey>): RawCardRecord {
  const { fields, raw } = row;
  // cardAdId/cardName/issuerName은 CARD_REQUIRED_KEYS로 이미 검증되어 null이 아니다.
  const cardAdId = fields.cardAdId;
  const cardName = fields.cardName;
  const issuerName = fields.issuerName;
  if (cardAdId === null || cardName === null || issuerName === null) {
    throw new Error("card_value_cards.csv: internal error building RawCardRecord");
  }
  return { ...fields, cardAdId, cardName, issuerName, raw };
}

function toBenefitRecord(row: ParsedRow<BenefitFieldKey>): RawBenefitRecord {
  const { fields, raw } = row;
  // cardAdId/benefitOrder는 BENEFIT_REQUIRED_KEYS로 이미 검증되어 null이 아니다.
  const cardAdId = fields.cardAdId;
  const benefitOrder = fields.benefitOrder;
  if (cardAdId === null || benefitOrder === null) {
    throw new Error("card_value_benefits.csv: internal error building RawBenefitRecord");
  }
  return { ...fields, cardAdId, benefitOrder, raw };
}

/** `card_value_cards.csv` 전체를 `RawCardRecord[]`로 구조화한다. 의미 해석은 하지 않는다. */
export function parseCardCsv(csv: string): RawCardDataset {
  const rows = parseDataset(csv, "card_value_cards.csv", CARD_FIELDS, CARD_REQUIRED_KEYS);
  return { cards: rows.map(toCardRecord) };
}

/** `card_value_benefits.csv` 전체를 `RawBenefitRecord[]`로 구조화한다. 의미 해석은 하지 않는다. */
export function parseBenefitCsv(csv: string): RawBenefitDataset {
  const rows = parseDataset(csv, "card_value_benefits.csv", BENEFIT_FIELDS, BENEFIT_REQUIRED_KEYS);
  return { benefits: rows.map(toBenefitRecord) };
}
