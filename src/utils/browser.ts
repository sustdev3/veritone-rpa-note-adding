import { Browser, Page, chromium } from "playwright";
import logger from "./logger";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function launchBrowser(): Promise<{ browser: Browser; page: Page }> {
  logger.info("Launching browser...");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: USER_AGENT,
  });
  const page = await context.newPage();

  logger.info("Browser launched.");
  return { browser, page };
}

export async function closeBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
    logger.info("Browser closed.");
  } catch (error) {
    logger.error(`Failed to close browser: ${error}`);
  }
}
