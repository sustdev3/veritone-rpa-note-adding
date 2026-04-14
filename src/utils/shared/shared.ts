import { Browser, Page } from "playwright";
import logger from "../logger";

export interface BrowserSession {
  page: Page;
  browser: Browser;
}

export async function randomDelay(): Promise<void> {
  const ms = Math.random() * 1000 + 3000; // 3000–4000ms
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cleanupSession(session: BrowserSession): Promise<void> {
  try {
    await randomDelay();
    logger.info("Navigating to manage adverts...");
    await session.page.locator("a#prim_manage").click();
    await session.page.waitForLoadState("domcontentloaded");
    logger.info("Manage adverts page loaded.");

    logger.info("Clicking logout button...");
    await session.page.locator("li#logout a").click();
    await session.page.waitForURL(/login\.cgi/, { timeout: 10000 });
    logger.info("Logged out successfully. Login page confirmed.");
  } catch (err) {
    logger.warn(`Logout did not complete cleanly: ${(err as Error).message}`);
  }

  logger.info("Closing browser...");
  await session.browser.close();
  logger.info("Browser closed.");
}
