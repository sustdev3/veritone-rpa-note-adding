import dotenv from "dotenv";
import { launchBrowser } from "./utils/browser";
import { login } from "./automation/login";
import { navigateToAdvert } from "./automation/adverts";
import { getUnprocessedRows } from "./services/sheets";
import { cleanupSession, BrowserSession, randomDelay } from "./utils/shared/shared";
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

    for (const candidate of candidates) {
      logger.info(
        `Processing candidate: ${candidate.candidateName} for advert: ${candidate.advertTitle}`,
      );

      const advertId = await navigateToAdvert(session.page, candidate.advertTitle);
      logger.info(`Navigated to advert with ID: ${advertId}`);

      await randomDelay();
    }

    // TODO: add note-adding automation steps here
  } catch (error) {
    logger.error(`RPA encountered an error: ${error}`);
  } finally {
    if (session) await cleanupSession(session);
  }
}

main();
