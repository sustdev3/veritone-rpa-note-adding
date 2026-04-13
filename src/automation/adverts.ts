import { Page } from "playwright";
import logger from "../utils/logger";
import { randomDelay } from "../utils/shared/shared";

async function clickManageAdverts(page: Page): Promise<void> {
  logger.info("Clicking Manage Adverts...");
  await page.click('a[href*="manage-vacancies.cgi"]');
}

async function searchAdvertByTitle(
  page: Page,
  advertTitle: string,
): Promise<void> {
  logger.info(`Searching for advert: "${advertTitle}"`);

  await page.locator("input[id='searchbar_keywords']").clear();
  await page
    .locator("input[id='searchbar_keywords']")
    .pressSequentially(advertTitle, { delay: 80 });
  await page.click("button[class='searchsubmit']");

  logger.info("Waiting for results table to appear...");
  await page.waitForSelector("table.managevacancies");
}

async function selectAdvertResult(
  page: Page,
  resultIndex: number = 0,
): Promise<{ advertId: string; totalResults: number }> {
  logger.info("Selecting advert result...");
  const links = await page.locator("a.jobtitle.no_dragdrop").all();

  if (links.length === 0) {
    throw new Error("No adverts found for title: {advertTitle}");
  }

  if (resultIndex >= links.length) {
    throw new Error(
      `Result index ${resultIndex} out of range. Only ${links.length} advert(s) found.`,
    );
  }

  const href = await links[resultIndex].getAttribute("href");
  if (!href) {
    throw new Error("Unable to extract href from selected advert");
  }

  const match = href.match(/advert_id=(\d+)/);
  if (!match || !match[1]) {
    throw new Error(`Unable to extract advert_id from href: ${href}`);
  }

  const advertId = match[1];
  logger.info(
    `Selected advert with ID: ${advertId} (result ${resultIndex + 1}/${links.length})`,
  );

  logger.info("Clicking advert link and waiting for page load...");
  await links[resultIndex].click();
  await page.waitForLoadState("networkidle", { timeout: 15000 });

  return { advertId, totalResults: links.length };
}

export async function navigateToAdvert(
  page: Page,
  advertTitle: string,
  resultIndex: number = 0,
): Promise<{ advertId: string; totalResults: number }> {
  await clickManageAdverts(page);
  await randomDelay();

  await searchAdvertByTitle(page, advertTitle);
  await randomDelay();

  const result = await selectAdvertResult(page, resultIndex);
  return result;
}
