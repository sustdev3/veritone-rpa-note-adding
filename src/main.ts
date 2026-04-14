import dotenv from "dotenv";
import { launchBrowser } from "./utils/browser";
import { login } from "./automation/login";
import { getUnprocessedRows } from "./services/sheets";
import { processAllCandidatesByAdvert } from "./orchestration/candidate-processesor";
import { cleanupSession, BrowserSession } from "./utils/shared/shared";
import logger from "./utils/logger";
import { sendErrorEmail } from "./services/email";

dotenv.config();

// Global error handlers
process.on('uncaughtException', async (error: Error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  logger.error(`Stack: ${error.stack}`);

  await sendErrorEmail(
    `S1HR RPA — Global Crash: ${error.message}`,
    `${error.message}\n\nStack Trace:\n${error.stack}`
  );

  process.exit(1);
});

process.on('unhandledRejection', async (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error(`Unhandled Rejection: ${error.message}`);
  logger.error(`Stack: ${error.stack}`);

  await sendErrorEmail(
    `S1HR RPA — Global Crash: ${error.message}`,
    `${error.message}\n\nStack Trace:\n${error.stack}`
  );

  process.exit(1);
});

async function main(): Promise<void> {
  let session: BrowserSession | null = null;

  try {
    const launched = await launchBrowser();
    session = launched;

    await login(session.page);
    logger.info("RPA ready.");

    const candidates = await getUnprocessedRows();
    const failedCandidates = await processAllCandidatesByAdvert(session.page, candidates);

    if (failedCandidates.length > 0) {
      const failedCount = failedCandidates.length;
      const failureList = failedCandidates
        .map((f) => `- ${f.name} (${f.email}) [Row ${f.rowIndex}]: ${f.error}`)
        .join('\n');

      await sendErrorEmail(
        `S1HR RPA — Run Complete With Errors (${failedCount} failed)`,
        `The RPA run completed with ${failedCount} failed candidate(s):\n\n${failureList}`
      );
    }
  } catch (error) {
    logger.error(`RPA encountered an error: ${error}`);
  } finally {
    if (session) await cleanupSession(session);
  }
}

main();
