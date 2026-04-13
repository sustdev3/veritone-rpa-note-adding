import { Page } from "playwright";
import logger from "../utils/logger";
import { randomDelay } from "../utils/shared/shared";

async function clickManageAdverts(page: Page): Promise<void> {
  logger.info("Clicking Manage Adverts...");
  await page.click("a#prim_manage");
}

async function searchAdvertByTitle(
  page: Page,
  advertTitle: string,
): Promise<void> {
  logger.info(`Searching for advert: "${advertTitle}"`);
  await page.fill("input[id='searchbar_keywords']", advertTitle);
  await page.click("button[class='searchsubmit']");

  logger.info("Waiting for results table to appear...");
  await page.waitForSelector("table.managevacancies");
}

async function selectAdvertResult(page: Page): Promise<string> {
  logger.info("Selecting advert result...");
  const links = await page.locator("a.jobtitle.no_dragdrop").all();

  if (links.length === 0) {
    throw new Error("No adverts found for title: {advertTitle}");
  }

  const href = await links[0].getAttribute("href");
  if (!href) {
    throw new Error("Unable to extract href from selected advert");
  }

  const match = href.match(/advert_id=(\d+)/);
  if (!match || !match[1]) {
    throw new Error(`Unable to extract advert_id from href: ${href}`);
  }

  const advertId = match[1];
  logger.info(`Selected advert with ID: ${advertId}`);

  logger.info("Clicking advert link and waiting for page load...");
  await links[0].click();
  await page.waitForLoadState("networkidle", { timeout: 15000 });

  return advertId;
}

export async function navigateToAdvert(
  page: Page,
  advertTitle: string,
): Promise<string> {
  await clickManageAdverts(page);
  await randomDelay();

  await searchAdvertByTitle(page, advertTitle);
  await randomDelay();

  const advertId = await selectAdvertResult(page);
  return advertId;
}
