import dotenv from "dotenv";
import { launchBrowser } from "./utils/browser";
import { login } from "./automation/login";
import { getUnprocessedRows } from "./services/sheets";
import { processAllCandidatesByAdvert } from "./orchestration/candidate-processesor";
import { cleanupSession, BrowserSession } from "./utils/shared/shared";
import logger, { resetLogFile } from "./utils/logger";
import { sendErrorEmail } from "./services/email";

dotenv.config();

export function aestTimestamp(): string {
  return new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "full",
    timeStyle: "medium",
  });
}

export async function launchAndLogin(): Promise<BrowserSession> {
  const { context, page } = await launchBrowser();
  const session: BrowserSession = { context, page };

  await login(session.page);

  // Reset log file after login so each day's log contains only the current session
  resetLogFile();
  logger.info(`RPA session started at ${aestTimestamp()} AEST`);

  return session;
}

// Returns true if candidates were found and processed, false if the sheet had nothing to do.
export async function runBatch(
  session: BrowserSession,
  shouldStop: () => boolean = () => false,
): Promise<boolean> {
  const candidates = await getUnprocessedRows();

  if (candidates.length === 0) {
    logger.info("No unprocessed candidates found in the sheet.");
    return false;
  }

  const failedCandidates = await processAllCandidatesByAdvert(
    session.page,
    candidates,
    shouldStop,
  );

  if (failedCandidates.length > 0) {
    const failedCount = failedCandidates.length;
    const failureList = failedCandidates
      .map((f) => `- ${f.name} (${f.email}) [Row ${f.rowIndex}]: ${f.error}`)
      .join("\n");

    await sendErrorEmail(
      `S1HR RPA — Batch Complete With Errors (${failedCount} failed)`,
      `The RPA batch completed with ${failedCount} failed candidate(s):\n\n${failureList}`,
    );
  }

  return true;
}

export async function logoutAndClose(session: BrowserSession): Promise<void> {
  await cleanupSession(session);
}

// Standalone one-off run — used by `npm run dev` / `npm start`
if (require.main === module) {
  process.on("uncaughtException", async (error: Error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    await sendErrorEmail(
      `S1HR RPA — Global Crash: ${error.message}`,
      `${error.message}\n\nStack Trace:\n${error.stack}`,
    );
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(`Unhandled Rejection: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    await sendErrorEmail(
      `S1HR RPA — Global Crash: ${error.message}`,
      `${error.message}\n\nStack Trace:\n${error.stack}`,
    );
    process.exit(1);
  });

  (async () => {
    let session: BrowserSession | null = null;
    try {
      session = await launchAndLogin();
      await runBatch(session);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`RPA encountered a breaking error: ${err.message}`);
      logger.error(`Stack: ${err.stack}`);
      await sendErrorEmail(
        `S1HR RPA — Breaking Error`,
        `The RPA run was aborted due to an unrecoverable error.\n\n` +
          `Error: ${err.message}\n\nStack Trace:\n${err.stack}`,
      );
    } finally {
      if (session) {
        logger.info(`RPA session ended at ${aestTimestamp()} AEST`);
        await logoutAndClose(session);
      }
    }
  })();
}
