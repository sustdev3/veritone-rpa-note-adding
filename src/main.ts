import dotenv from "dotenv";
import { launchBrowser } from "./utils/browser";
import { login } from "./automation/login";
import { navigateToAdvert } from "./automation/adverts";
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

    const advertId = await navigateToAdvert(
      session.page,
      "Storeperson with Forklift license - $35.53 per hour",
    );
    logger.info(`Navigated to advert with ID: ${advertId}`);

    // TODO: add note-adding automation steps here
  } catch (error) {
    logger.error(`RPA encountered an error: ${error}`);
  } finally {
    if (session) await cleanupSession(session);
  }
}

main();
