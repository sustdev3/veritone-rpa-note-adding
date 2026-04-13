import dotenv from "dotenv";
import { Browser } from "playwright";
import { launchBrowser, closeBrowser } from "./utils/browser";
import { login } from "./automation/login";
import logger from "./utils/logger";

dotenv.config();

async function main(): Promise<void> {
  let browser: Browser | null = null;

  try {
    const launched = await launchBrowser();
    browser = launched.browser;

    await login(launched.page);
    logger.info("RPA ready.");

    // TODO: add note-adding automation steps here
  } catch (error) {
    logger.error(`RPA encountered an error: ${error}`);
  } finally {
    if (browser) await closeBrowser(browser);
  }
}

main();
