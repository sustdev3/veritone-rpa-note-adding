import dotenv from "dotenv";
import { launchBrowser } from "./utils/browser";
import { login } from "./automation/login";
import { getUnprocessedRows } from "./services/sheets";
import { processAllCandidatesByAdvert, AdvertRunResult } from "./orchestration/candidate-processesor";
import { cleanupSession, BrowserSession } from "./utils/shared/shared";
import logger, { resetLogFile } from "./utils/logger";
import { sendErrorEmail } from "./services/email";

dotenv.config();

export { AdvertRunResult };

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

// Returns advertResults from this batch, or null if the sheet had nothing to do.
export async function runBatch(
  session: BrowserSession,
  shouldStop: () => boolean = () => false,
): Promise<AdvertRunResult[] | null> {
  const candidates = await getUnprocessedRows();

  if (candidates.length === 0) {
    logger.info("No unprocessed candidates found in the sheet.");
    return null;
  }

  const { failed: failedCandidates, advertResults } = await processAllCandidatesByAdvert(
    session.page,
    candidates,
    shouldStop,
  );

  if (failedCandidates.length > 0) {
    const failedCount = failedCandidates.length;
    const failureList = failedCandidates
      .map((f) => `- ${f.name} (${f.email}) [Row ${f.rowIndex}]: ${f.reason}`)
      .join("\n");

    await sendErrorEmail(
      `S1HR RPA — Batch Complete With Errors (${failedCount} failed)`,
      `The RPA batch completed with ${failedCount} failed candidate(s):\n\n${failureList}`,
    );
  }

  return advertResults;
}

export async function logoutAndClose(session: BrowserSession): Promise<void> {
  await cleanupSession(session);
}
