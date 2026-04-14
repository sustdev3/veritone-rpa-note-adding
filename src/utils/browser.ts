import { Browser, Page, chromium } from "playwright";
import logger from "./logger";

export async function launchBrowser(): Promise<{
  browser: Browser;
  page: Page;
}> {
  logger.info("Launching browser...");

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--force-device-scale-factor=1",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
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
