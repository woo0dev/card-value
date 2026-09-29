import { runIngestion } from "../src/lib/ingestion/run";

/**
 * CLI 진입점.
 *   npm run ingest:cards -- --dry-run                    (DB에 쓰지 않고 결과만 출력)
 *   npm run ingest:cards -- --card-id=1294 --dry-run      (카드 1개만, dry-run)
 *   npm run ingest:cards -- --card-id=1294                (카드 1개만 실제 적재 — 통합 테스트용)
 *   npm run ingest:cards                                  (전체 443개 실제 적재)
 */
function parseArgs(argv: readonly string[]): { readonly dryRun: boolean; readonly cardAdId?: string } {
  const cardIdArg = argv.find((arg) => arg.startsWith("--card-id="));
  return {
    dryRun: argv.includes("--dry-run"),
    cardAdId: cardIdArg?.slice("--card-id=".length),
  };
}

function printReport(report: Awaited<ReturnType<typeof runIngestion>>): void {
  console.log(report.dryRun ? "=== DRY RUN (실제 DB에는 쓰지 않음) ===" : "=== 실제 Supabase 프로젝트에 적재 완료 ===");
  console.log(`raw cards: ${report.rawCards}`);
  console.log(`raw benefits: ${report.rawBenefits}`);
  console.log(`toDomain success: ${report.toDomainSuccess}`);
  console.log(`toDomain failed: ${report.toDomainFailed}`);
  console.log(`validation success: ${report.validationSuccess}`);
  console.log(`validation failed: ${report.validationFailed}`);
  console.log(`cards to insert: ${report.cardsToInsert}`);
  console.log(`spending benefits: ${report.spendingBenefits}`);
  console.log(`perks: ${report.perks}`);
  console.log(`performance tiers: ${report.performanceTiers}`);
  console.log(`raw card snapshots: ${report.rawCardSnapshots}`);
  console.log(`raw benefit snapshots: ${report.rawBenefitSnapshots}`);
}

async function main(): Promise<void> {
  const { dryRun, cardAdId } = parseArgs(process.argv.slice(2));
  const report = await runIngestion({ dryRun, cardAdId });
  printReport(report);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
