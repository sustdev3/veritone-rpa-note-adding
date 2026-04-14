import { Page } from "playwright";
import logger from "../utils/logger";
import { randomDelay } from "../utils/shared/shared";
import { CandidateRow } from "../services/sheets";

export async function openResponsesTab(page: Page): Promise<void> {
  logger.info("Clicking Responses tab...");
  await page.click('a[href*="adcresponses"]');
  await page.waitForLoadState("networkidle");
  await randomDelay();
}

async function searchCandidate(
  page: Page,
  candidateEmail: string,
): Promise<void> {
  logger.info(`Searching for candidate: "${candidateEmail}"`);

  await page.waitForLoadState("domcontentloaded");
  await page.locator("textarea.keywords").waitFor({ state: "visible" });

  await page.locator("textarea.keywords").clear();
  await page
    .locator("textarea.keywords")
    .pressSequentially(candidateEmail, { delay: 80 });

  await page.click("section#main-criteria button.btn.btn-success");

  logger.info("Waiting for search results to load...");
  await page.waitForFunction(
    () => {
      const text = document.querySelector("h4#search-activity")?.textContent ?? "";
      return (
        text.trim() !== "" &&
        !text.includes("Loading") &&
        !text.includes("...")
      );
    },
    { timeout: 15000, polling: 500 },
  );

  await randomDelay();
}

async function selectCandidate(page: Page): Promise<boolean> {
  logger.info("Checking for candidate results...");

  const results = page.locator(".result .head-details a.email");
  const count = await results.count();
  logger.info(`Found ${count} candidate result(s).`);

  if (count === 0) {
    logger.info("No candidate results found.");
    return false;
  }

  const firstResult = page.locator("div.result.searchable").first();
  const candidateId = await firstResult.getAttribute("external-candidate-id");
  logger.info(`Opening candidate profile with ID: ${candidateId}`);

  const eyeButton = page.locator(
    `div.result.searchable[external-candidate-id="${candidateId}"] button.button-candidate-action-profile`,
  );
  await eyeButton.click();
  await page.locator("div.profile-box").waitFor({ state: "visible" });
  await page.waitForTimeout(1500);

  return true;
}

async function enterNotes(page: Page, row: CandidateRow): Promise<void> {
  logger.info("Confirming note fields are available...");

  const textArea = page.locator("#add_note textarea");
  await textArea.waitFor({ state: "visible" });
  logger.info("Found note textarea field.");

  const button = page.locator('#add_note button:not([data-dropdown])');
  await button.waitFor({ state: "visible" });
  logger.info("Found note button.");

  const timestamp = new Date().toLocaleString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  const noteContent = [
    `--- Screening Form Response (${timestamp}) ---`,
    `Suburb: ${row.suburb}`,
    `Car & Licence: ${row.carLicence}`,
    `Fulltime Hours: ${row.fulltimeHours}`,
    `Immediate Start: ${row.immediateStart}`,
    `Preferred Shift: ${row.preferredShift}`,
    `---`,
  ].join('\n');

  logger.info("Counting existing notes before submission...");
  const notesBeforeCount = await page.locator('ul.notes-list li.note').count();
  logger.info(`Notes before: ${notesBeforeCount}`);

  logger.info("Typing note content into textarea...");
  const lines = noteContent.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      await page.locator('#add_note textarea').pressSequentially(lines[i], { delay: 30 });
    }
    if (i < lines.length - 1) {
      await page.keyboard.press('Enter');
    }
  }
  logger.info("Note content entered successfully.");

  logger.info("Clicking submit button...");
  await button.click();

  logger.info("Waiting for note to appear in notes list...");
  await page.waitForFunction(
    (before) => document.querySelectorAll('ul.notes-list li.note').length > before,
    notesBeforeCount,
    { timeout: 10000, polling: 500 }
  );
  logger.info("Note saved successfully.");

  logger.info("Closing candidate profile modal...");
  await page.locator("a.profile-close").click();
  logger.info("Candidate profile modal closed.");
}

export async function findAndProcessCandidate(
  page: Page,
  candidateEmail: string,
  row: CandidateRow,
): Promise<boolean> {
  await searchCandidate(page, candidateEmail);

  const found = await selectCandidate(page);

  if (found) {
    await enterNotes(page, row);
  }

  return found;
}
