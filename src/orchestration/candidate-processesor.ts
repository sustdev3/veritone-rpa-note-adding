import { Page } from "playwright";
import logger from "../utils/logger";
import {
  navigateToManageAdverts,
  readRecentAdverts,
  navigateToAdvertById,
  searchAndNavigateToAdvert,
} from "../automation/adverts";
import { openResponsesTab, findAndProcessCandidate } from "../automation/responses";
import {
  CandidateRow,
  markRowAsProcessed,
  incrementRowAttempt,
} from "../services/sheets";
import { randomDelay } from "../utils/shared/shared";

interface FailedCandidate {
  name: string;
  email: string;
  rowIndex: number;
  reason: string;
}

async function processGroupInAdvert(
  page: Page,
  group: CandidateRow[],
  advertLabel: string,
  shouldStop: () => boolean,
): Promise<CandidateRow[]> {
  // Returns candidates that were NOT found in this advert (for fallback iteration)
  const notFound: CandidateRow[] = [];

  await openResponsesTab(page);

  for (const candidate of group) {
    if (shouldStop()) {
      logger.info(`[Scheduler] Stop signal received. Deferring "${candidate.candidateName}" and remaining.`);
      notFound.push(...group.slice(group.indexOf(candidate)));
      break;
    }

    logger.info(`Searching for candidate: ${candidate.candidateName} (${candidate.candidateEmail})`);

    try {
      const found = await findAndProcessCandidate(page, candidate.candidateEmail, candidate);

      if (found) {
        logger.info(`✓ Processed ${candidate.candidateName} in ${advertLabel}.`);
        await markRowAsProcessed(candidate.rowIndex);
        logger.info(`Marked row ${candidate.rowIndex} as processed.`);
      } else {
        logger.warn(`✗ ${candidate.candidateName} not found in ${advertLabel}.`);
        notFound.push(candidate);
      }
    } catch (error) {
      const msg = (error as Error).message;
      logger.error(`Error processing ${candidate.candidateName}: ${msg}`);
      notFound.push(candidate);
    }

    await randomDelay();
  }

  return notFound;
}

export async function processAllCandidatesByAdvert(
  page: Page,
  candidates: CandidateRow[],
  shouldStop: () => boolean = () => false,
): Promise<FailedCandidate[]> {
  const failedCandidates: FailedCandidate[] = [];

  // --- Phase 1: candidates with adref_no — search directly by adref ---

  const withAdref = candidates.filter(c => c.adrefNo.trim().length > 0);
  const fallbackCandidates: CandidateRow[] = candidates.filter(c => c.adrefNo.trim().length === 0);

  if (fallbackCandidates.length > 0) {
    logger.info(`${fallbackCandidates.length} candidate(s) have no adref_no — will fall back to 30-day advert iteration`);
  }

  // Group by adref_no so each advert is only opened once
  const groupedByAdref = new Map<string, CandidateRow[]>();
  for (const candidate of withAdref) {
    const group = groupedByAdref.get(candidate.adrefNo) ?? [];
    group.push(candidate);
    groupedByAdref.set(candidate.adrefNo, group);
  }

  logger.info(`Processing ${groupedByAdref.size} unique adref_no group(s)`);

  for (const [adrefNo, group] of groupedByAdref) {
    if (shouldStop()) {
      logger.info(`[Scheduler] Stop signal received before adref_no "${adrefNo}". Deferring remaining.`);
      // Keep unprocessed candidates for next run (no sheet update)
      break;
    }

    const advertHint = group[0].advertHint;
    logger.info(`Adref_no "${adrefNo}" — ${group.length} candidate(s) (hint: "${advertHint}")`);

    await navigateToManageAdverts(page);

    const advertFound = await searchAndNavigateToAdvert(page, adrefNo, advertHint);

    if (!advertFound) {
      logger.warn(`No advert found for adref_no "${adrefNo}" — adding ${group.length} candidate(s) to 30-day fallback`);
      fallbackCandidates.push(...group);
      continue;
    }

    const notFoundInAdvert = await processGroupInAdvert(
      page,
      group,
      `adref_no "${adrefNo}"`,
      shouldStop,
    );

    // Candidates not found in the targeted advert fall through to the 30-day iteration
    if (notFoundInAdvert.length > 0) {
      logger.info(`${notFoundInAdvert.length} candidate(s) not found in adref "${adrefNo}" advert — adding to 30-day fallback`);
      fallbackCandidates.push(...notFoundInAdvert);
    }
  }

  // --- Phase 2: fallback — iterate all adverts from last 30 days ---

  if (fallbackCandidates.length > 0 && !shouldStop()) {
    logger.info(`Starting 30-day advert iteration for ${fallbackCandidates.length} candidate(s)`);

    await navigateToManageAdverts(page);
    const allAdverts = await readRecentAdverts(page, 30);
    logger.info(`Found ${allAdverts.length} adverts in last 30 days`);

    let remainingCandidates = [...fallbackCandidates];
    let outerStopped = false;

    for (const advert of allAdverts) {
      if (shouldStop()) {
        logger.info(`[Scheduler] Stop signal received before advert "${advert.jobTitle}". Deferring remaining.`);
        outerStopped = true;
        break;
      }

      if (remainingCandidates.length === 0) break;

      await navigateToManageAdverts(page);
      logger.info(`Opening advert "${advert.jobTitle}" (ID: ${advert.advertId})`);
      await navigateToAdvertById(page, advert.advertId, advert.pageNumber);

      const stillNotFound = await processGroupInAdvert(
        page,
        remainingCandidates,
        `advert "${advert.jobTitle}"`,
        shouldStop,
      );

      remainingCandidates = stillNotFound;

      if (shouldStop()) {
        outerStopped = true;
        break;
      }

      await randomDelay();
    }

    // Candidates still not found after all adverts → increment attempt
    if (remainingCandidates.length > 0 && !outerStopped) {
      logger.warn(`${remainingCandidates.length} candidate(s) not found in any advert after full iteration:`);
      for (const candidate of remainingCandidates) {
        logger.warn(`  - ${candidate.candidateName} (${candidate.candidateEmail}) [Row ${candidate.rowIndex}]`);
        await incrementRowAttempt(candidate.rowIndex, candidate.processed);
        failedCandidates.push({
          name: candidate.candidateName,
          email: candidate.candidateEmail,
          rowIndex: candidate.rowIndex,
          reason: "Not found in any advert after full 30-day iteration",
        });
      }
    }
  }

  if (failedCandidates.length > 0) {
    logger.warn(`\n=== FAILED CANDIDATES SUMMARY ===`);
    logger.warn(`Total failed: ${failedCandidates.length}`);
    for (const failed of failedCandidates) {
      logger.warn(`  - ${failed.name} (${failed.email}) [Row ${failed.rowIndex}]: ${failed.reason}`);
    }
  }

  return failedCandidates;
}
