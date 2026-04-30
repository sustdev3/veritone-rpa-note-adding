import { Page } from "playwright";
import logger from "../utils/logger";
import { randomDelay } from "../utils/shared/shared";
import { login } from "./login";

export interface AdvertSummary {
  advertId: string;
  refNumber: string;
  jobTitle: string;
  datePosted: Date;
  pageNumber: number;
}

export async function navigateToManageAdverts(page: Page): Promise<void> {
  logger.info("Navigating to Manage Adverts...");
  await page.click('a[href*="manage-vacancies.cgi"]');
  await page.waitForLoadState("domcontentloaded");

  if (page.url().includes("login.cgi")) {
    logger.warn("[Session] Session expired — re-logging in...");
    await login(page);
    logger.info("[Session] Re-login successful. Retrying navigation to Manage Adverts...");
    await page.click('a[href*="manage-vacancies.cgi"]');
    await page.waitForLoadState("domcontentloaded");
  }

  await page.waitForSelector("table.managevacancies", { timeout: 15000 });
  await randomDelay();
}

function parseAdvertDate(raw: string): Date | null {
  // Try "d MMM yy HH:mm" e.g. "10 Apr 26 19:00"
  // Try "d MMM yyyy HH:mm" e.g. "10 Apr 2026 19:00"
  const match = raw.match(/^(\d{1,2})\s+(\w{3})\s+(\d{2,4})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, day, mon, yearRaw, hour, min] = match;
  const year = yearRaw.length === 2 ? 2000 + parseInt(yearRaw) : parseInt(yearRaw);
  const dateStr = `${day} ${mon} ${year} ${hour}:${min}`;
  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export async function readRecentAdverts(page: Page, lookbackDays = parseInt(process.env.LOOKBACK_DAYS ?? "30", 10)): Promise<AdvertSummary[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const collected: AdvertSummary[] = [];
  let currentPage = 1;
  let stopPaginating = false;

  while (true) {
    const rows = await page.evaluate(() => {
      const results: { advertId: string | null; refNumber: string; jobTitle: string; rawDate: string }[] = [];
      const rowEls = Array.from(document.querySelectorAll("tr.va-top.advert.last"));
      for (const row of rowEls) {
        const titleLink = row.querySelector("a.jobtitle.no_dragdrop");
        const href = titleLink?.getAttribute("href") ?? "";
        const advertIdMatch = href.match(/advert_id=(\d+)/);
        const advertId = advertIdMatch?.[1] ?? null;
        const jobTitle = titleLink?.textContent?.trim() ?? "";
        const tds = row.querySelectorAll("td");
        const rawDate = tds[1]?.textContent?.trim().replace(/\s+/g, " ") ?? "";
        const row2 = row.nextElementSibling;
        const tds2 = row2?.querySelectorAll("td");
        const refRaw = tds2?.[0]?.textContent?.trim() ?? "";
        const refNumber = refRaw.replace(/Ref\s*No\.?:?\s*/i, "").trim();
        results.push({ advertId, refNumber, jobTitle, rawDate });
      }
      return results;
    });

    for (const row of rows) {
      if (!row.advertId) continue;

      const datePosted = parseAdvertDate(row.rawDate);
      if (!datePosted) {
        logger.warn(`Could not parse date "${row.rawDate}" for advert "${row.jobTitle}" — skipping`);
        continue;
      }

      if (datePosted < cutoff) {
        stopPaginating = true;
        break;
      }

      collected.push({ advertId: row.advertId, refNumber: row.refNumber, jobTitle: row.jobTitle, datePosted, pageNumber: currentPage });
    }

    if (stopPaginating) break;

    const nextPageNum = currentPage + 1;
    const nextLink = page.locator(".paginator a").filter({ hasText: new RegExp(`^${nextPageNum}$`) }).first();
    const exists = await nextLink.count() > 0;
    if (!exists) break;

    await randomDelay();
    await nextLink.click();
    await page.waitForLoadState("domcontentloaded");
    currentPage++;
  }

  collected.sort((a, b) => b.datePosted.getTime() - a.datePosted.getTime());

  logger.info(`Found ${collected.length} adverts in last ${lookbackDays} days`);
  return collected;
}

// Navigates to the page of the manage adverts table that contains the advert,
// then clicks the advert link. Assumes we are already on the Manage Adverts page.
export async function navigateToAdvertById(page: Page, advertId: string, pageNumber: number): Promise<void> {
  logger.info(`Navigating to advert ID: ${advertId} (on page ${pageNumber})`);

  // Paginate to the correct page if not already on it
  if (pageNumber > 1) {
    const pageLink = page.locator(".paginator a").filter({ hasText: new RegExp(`^${pageNumber}$`) }).first();
    const exists = await pageLink.count() > 0;
    if (!exists) {
      throw new Error(`Paginator link for page ${pageNumber} not found`);
    }
    await pageLink.click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("table.managevacancies", { timeout: 15000 });
    await randomDelay();
  }

  await page.click(`a.jobtitle.no_dragdrop[href*="advert_id=${advertId}"]`);
  await page.waitForLoadState("networkidle", { timeout: 15000 });
  await randomDelay();
}

// Searches by adref_no and returns ALL matching adverts across all dates (no lookback restriction).
// Leaves the manage adverts page in its default (unfiltered) state after returning.
// Sorted most recent first.
export async function searchAdvertsByAdrefNo(
  page: Page,
  adrefNo: string,
): Promise<Array<{ advertId: string; jobTitle: string; datePosted: string }>> {
  logger.info(`Searching all adverts for adref_no: "${adrefNo}" (no date restriction)`);

  await page.locator("input#searchbar_keywords").clear();
  await page.locator("input#searchbar_keywords").pressSequentially(adrefNo, { delay: 80 });
  await page.click("button.searchsubmit");
  await page.waitForSelector("table.managevacancies");
  await randomDelay();

  const rawResults = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("tr.va-top.advert.last")).map(row => {
      const titleLink = row.querySelector("a.jobtitle.no_dragdrop");
      const href = titleLink?.getAttribute("href") ?? "";
      const advertIdMatch = href.match(/advert_id=(\d+)/);
      const tds = row.querySelectorAll("td");
      const rawDate = tds[1]?.textContent?.trim().replace(/\s+/g, " ") ?? "";
      return {
        advertId: advertIdMatch?.[1] ?? null,
        jobTitle: titleLink?.textContent?.trim() ?? "",
        rawDate,
      };
    });
  });

  // Restore full unfiltered list
  await page.locator("input#searchbar_keywords").clear();
  await page.click("button.searchsubmit");
  await page.waitForSelector("table.managevacancies");
  await randomDelay();

  const results: Array<{ advertId: string; jobTitle: string; datePosted: string }> = [];
  for (const r of rawResults) {
    if (!r.advertId) continue;
    const date = parseAdvertDate(r.rawDate);
    if (!date) {
      logger.warn(`Could not parse date "${r.rawDate}" for advert "${r.jobTitle}" — excluding`);
      continue;
    }
    results.push({ advertId: r.advertId, jobTitle: r.jobTitle, datePosted: date.toISOString().substring(0, 10) });
  }

  results.sort((a, b) => b.datePosted.localeCompare(a.datePosted));
  logger.info(`adref_no "${adrefNo}": ${results.length} advert(s) found across all dates`);
  return results;
}

// Searches by adref_no, filters results to the lookback window, then uses advertHint
// to pick the correct advert among those. Navigates to the matched advert.
// Returns the chosen advert's { advertId, jobTitle } if found, or null if none pass the filters.
export async function searchAndNavigateToAdvert(page: Page, adrefNo: string, advertHint: string): Promise<{ advertId: string; jobTitle: string; datePosted: string } | null> {
  const lookbackDays = parseInt(process.env.LOOKBACK_DAYS ?? "30", 10);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  logger.info(`Searching for advert by adref_no: "${adrefNo}" (hint: "${advertHint}", lookback: ${lookbackDays} days)`);

  await page.locator("input#searchbar_keywords").clear();
  await page.locator("input#searchbar_keywords").pressSequentially(adrefNo, { delay: 80 });
  await page.click("button.searchsubmit");
  await page.waitForSelector("table.managevacancies");
  await randomDelay();

  // Scrape all result rows with their dates
  const rawResults = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("tr.va-top.advert.last")).map(row => {
      const titleLink = row.querySelector("a.jobtitle.no_dragdrop");
      const href = titleLink?.getAttribute("href") ?? "";
      const advertIdMatch = href.match(/advert_id=(\d+)/);
      const tds = row.querySelectorAll("td");
      const rawDate = tds[1]?.textContent?.trim().replace(/\s+/g, " ") ?? "";
      return {
        advertId: advertIdMatch?.[1] ?? null,
        jobTitle: titleLink?.textContent?.trim() ?? "",
        rawDate,
      };
    });
  });

  if (rawResults.length === 0) {
    logger.warn(`No adverts found for adref_no "${adrefNo}" — falling back to full iteration`);
    await page.locator("input#searchbar_keywords").clear();
    await page.click("button.searchsubmit");
    await page.waitForSelector("table.managevacancies");
    await randomDelay();
    return null;
  }

  // Filter to results within the lookback window
  const withinWindow = rawResults.filter(r => {
    if (!r.advertId) return false;
    const date = parseAdvertDate(r.rawDate);
    if (!date) {
      logger.warn(`Could not parse date "${r.rawDate}" for advert "${r.jobTitle}" — excluding`);
      return false;
    }
    return date >= cutoff;
  });

  logger.info(`adref_no "${adrefNo}": ${rawResults.length} result(s) total, ${withinWindow.length} within lookback window`);

  if (withinWindow.length === 0) {
    logger.warn(`No results for adref_no "${adrefNo}" within the last ${lookbackDays} days — falling back to full iteration`);
    await page.locator("input#searchbar_keywords").clear();
    await page.click("button.searchsubmit");
    await page.waitForSelector("table.managevacancies");
    await randomDelay();
    return null;
  }

  // Among results within the window, pick the one matching the hint
  let chosen = withinWindow[0];
  if (advertHint.trim().length > 0) {
    const hint = advertHint.trim().toLowerCase();
    const hintMatch = withinWindow.find(r => r.jobTitle.toLowerCase().includes(hint));
    if (hintMatch) {
      chosen = hintMatch;
      logger.info(`Hint "${advertHint}" matched advert "${chosen.jobTitle}"`);
    } else {
      logger.warn(`Hint "${advertHint}" did not match any result within the window — using most recent: "${chosen.jobTitle}"`);
    }
  }

  logger.info(`Navigating to advert "${chosen.jobTitle}" (advert ID: ${chosen.advertId})`);
  await page.click(`a.jobtitle.no_dragdrop[href*="advert_id=${chosen.advertId}"]`);
  await page.waitForLoadState("networkidle", { timeout: 15000 });
  await randomDelay();

  const chosenDate = parseAdvertDate(chosen.rawDate);
  const datePosted = chosenDate ? chosenDate.toISOString().substring(0, 10) : "";
  return { advertId: chosen.advertId!, jobTitle: chosen.jobTitle, datePosted };
}
