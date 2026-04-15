import { BrowserContext, Page } from "playwright";
import logger from "../logger";

export interface BrowserSession {
  page: Page;
  context: BrowserContext;
}

export async function randomDelay(): Promise<void> {
  const ms = Math.random() * 1000 + 2000; // 2000–3000ms
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Navigates to the home page without logging out — used to park between batches.
export async function navigateHome(session: BrowserSession): Promise<void> {
  try {
    await randomDelay();
    logger.info("Navigating to home page (parking between batches)...");
    await session.page.click('a[href*="index.cgi"]');
    await session.page.waitForLoadState("domcontentloaded");
    logger.info("Parked on home page.");
  } catch (err) {
    logger.warn(`Could not navigate home cleanly: ${(err as Error).message}`);
  }
}

// Logs out and closes the browser — used at end of day only.
export async function cleanupSession(session: BrowserSession): Promise<void> {
  try {
    await randomDelay();
    logger.info("Clicking Home link...");
    await session.page.click('a[href*="index.cgi"]');
    await session.page.waitForLoadState("domcontentloaded");
    logger.info("Home page loaded.");

    logger.info("Clicking logout button...");
    await session.page.locator("li#logout a").click();
    await session.page.waitForURL(/login\.cgi/, { timeout: 10000 });
    logger.info("Logged out successfully. Login page confirmed.");
  } catch (err) {
    logger.warn(`Logout did not complete cleanly: ${(err as Error).message}`);
  }

  logger.info("Closing browser...");
  await session.context.close();
  logger.info("Browser closed.");
}
