import dotenv from "dotenv";
import { launchBrowser } from "./utils/browser";
import { login } from "./automation/login";
import { getUnprocessedRows } from "./services/sheets";
import { processAllCandidatesByAdvert } from "./orchestration/candidate-processesor";
import { cleanupSession, BrowserSession } from "./utils/shared/shared";
import logger from "./utils/logger";

dotenv.config();

async function main(): Promise<void> {
  let session: BrowserSession | null = null;

  try {
    const launched = await launchBrowser();
    session = launched;

    await login(session.page);
    logger.info("RPA ready.");

    const candidates = await getUnprocessedRows();
    await processAllCandidatesByAdvert(session.page, candidates);
  } catch (error) {
    logger.error(`RPA encountered an error: ${error}`);
  } finally {
    if (session) await cleanupSession(session);
  }
}

main();
