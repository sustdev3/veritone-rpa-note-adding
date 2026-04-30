import { Page } from "playwright";
import logger from "../utils/logger";
import {
  navigateToManageAdverts,
  readRecentAdverts,
  navigateToAdvertById,
  searchAndNavigateToAdvert,
  searchAdvertsByAdrefNo,
} from "../automation/adverts";
import { openResponsesTab, findAndProcessCandidate } from "../automation/responses";
import {
  CandidateRow,
  markRowAsProcessed,
  markRowsAsSkipped,
  incrementRowAttempt,
} from "../services/sheets";
import { randomDelay } from "../utils/shared/shared";

interface FailedCandidate {
  name: string;
  email: string;
  rowIndex: number;
  reason: string;
}

function advertMatchesHint(advertTitle: string, advertHint: string): boolean {
  return advertHint.trim() === '' || advertTitle.toLowerCase().includes(advertHint.trim().toLowerCase());
}

export type ProcessingPhase = 'phase1Only' | 'phase2Only' | 'both';

export interface AdvertRunResult {
  adrefNo: string;
  advertTitle: string;
  candidatesProcessed: number;
  datePosted?: string;
}

async function processGroupInAdvert(
  page: Page,
  group: CandidateRow[],
  advertLabel: string,
  shouldStop: () => boolean,
): Promise<{ notFound: CandidateRow[]; processedCount: number }> {
  // Returns candidates that were NOT found in this advert (for fallback iteration)
  const notFound: CandidateRow[] = [];
  let processedCount = 0;

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
        processedCount++;
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

  return { notFound, processedCount };
}

async function tryFindCandidateByAdref(
  page: Page,
  candidate: CandidateRow,
  shouldStop: () => boolean,
): Promise<{ found: boolean; advertId?: string; jobTitle?: string; datePosted?: string }> {
  await navigateToManageAdverts(page);
  const adverts = await searchAdvertsByAdrefNo(page, candidate.adrefNo);

  if (adverts.length === 0) {
    logger.warn(`No adverts found for adref_no "${candidate.adrefNo}" — ${candidate.candidateName} cannot be processed via adrefNo`);
    return { found: false };
  }

  const lookbackDays = parseInt(process.env.LOOKBACK_DAYS ?? "30", 10);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  for (const advert of adverts) {
    if (shouldStop()) {
      logger.info(`[Scheduler] Stop signal received while trying advert "${advert.jobTitle}" for ${candidate.candidateName}`);
      return { found: false };
    }

    logger.info(`[Phase 2a] Trying advert "${advert.jobTitle}" (ID: ${advert.advertId}) for ${candidate.candidateName}`);

    await navigateToManageAdverts(page);
    await page.locator("input#searchbar_keywords").clear();
    await page.locator("input#searchbar_keywords").pressSequentially(candidate.adrefNo, { delay: 80 });
    await page.click("button.searchsubmit");
    await page.waitForSelector("table.managevacancies");
    await page.click(`a.jobtitle.no_dragdrop[href*="advert_id=${advert.advertId}"]`);
    await page.waitForLoadState("networkidle", { timeout: 15000 });
    await randomDelay();

    await openResponsesTab(page);
    const found = await findAndProcessCandidate(page, candidate.candidateEmail, candidate);

    if (found) {
      const isOutside = new Date(advert.datePosted) < cutoff;
      const processedValue = isOutside ? "OUTSIDE WINDOW" : "TRUE";
      await markRowAsProcessed(candidate.rowIndex, processedValue);
      if (isOutside) {
        logger.info(`[Phase 2a] ${candidate.candidateName} found in advert outside lookback window — marked "OUTSIDE WINDOW"`);
      }
      return { found: true, advertId: advert.advertId, jobTitle: advert.jobTitle, datePosted: advert.datePosted };
    }

    await randomDelay();
  }

  return { found: false };
}

export async function processAllCandidatesByAdvert(
  page: Page,
  candidates: CandidateRow[],
  shouldStop: () => boolean = () => false,
  phase: ProcessingPhase = 'both',
): Promise<{ failed: FailedCandidate[]; advertResults: AdvertRunResult[] }> {
  const failedCandidates: FailedCandidate[] = [];
  const advertResults: AdvertRunResult[] = [];

  // Skip candidates that have neither adrefNo nor advertHint — no safe way to match them to an advert
  const skippable = candidates.filter(c => c.adrefNo.trim() === '' && c.advertHint.trim() === '');
  const processable = candidates.filter(c => c.adrefNo.trim() !== '' || c.advertHint.trim() !== '');

  if (skippable.length > 0) {
    for (const candidate of skippable) {
      logger.warn(`Skipping ${candidate.candidateName} (row ${candidate.rowIndex}) — no adrefNo or advertHint`);
    }
    await markRowsAsSkipped(skippable.map(c => c.rowIndex));
  }

  if (phase === 'phase2Only') {
    if (processable.length === 0) {
      return { failed: failedCandidates, advertResults };
    }

    const byAdref = processable.filter(c => c.adrefNo.trim() !== '');
    const byHint: CandidateRow[] = processable.filter(c => c.adrefNo.trim() === '');

    logger.info(`Phase 2 — ${byAdref.length} candidate(s) with adrefNo (targeted search), ${byHint.length} without (hint-based fallback)`);

    // --- Phase 2a: targeted adrefNo search, no date restriction ---
    const adrefResultsMap = new Map<string, AdvertRunResult>();

    for (const candidate of byAdref) {
      if (shouldStop()) {
        logger.info(`[Scheduler] Stop signal received in Phase 2a. Deferring ${candidate.candidateName} and remaining.`);
        break;
      }

      try {
        const result = await tryFindCandidateByAdref(page, candidate, shouldStop);

        if (result.found) {
          logger.info(`✓ [Phase 2a] Processed ${candidate.candidateName} in "${result.jobTitle}"`);
          const existing = adrefResultsMap.get(result.advertId!);
          if (existing) {
            existing.candidatesProcessed++;
          } else {
            adrefResultsMap.set(result.advertId!, {
              adrefNo: candidate.adrefNo,
              advertTitle: result.jobTitle!,
              candidatesProcessed: 1,
              datePosted: result.datePosted,
            });
          }
        } else {
          logger.warn(`✗ [Phase 2a] ${candidate.candidateName} not found via adrefNo — adding to hint fallback`);
          byHint.push(candidate);
        }
      } catch (error) {
        logger.error(`[Phase 2a] Error processing ${candidate.candidateName}: ${(error as Error).message}`);
        byHint.push(candidate);
      }

      await randomDelay();
    }

    for (const result of adrefResultsMap.values()) {
      advertResults.push(result);
    }

    // --- Phase 2b: hint-based fallback for candidates without adrefNo ---
    if (byHint.length > 0 && !shouldStop()) {
      logger.info(`[Phase 2b] Hint-based iteration for ${byHint.length} candidate(s)`);

      await navigateToManageAdverts(page);
      const allAdverts = await readRecentAdverts(page, 30);
      logger.info(`Found ${allAdverts.length} adverts in last 30 days`);

      let remainingCandidates = [...byHint];
      let outerStopped = false;

      for (const advert of allAdverts) {
        if (shouldStop()) {
          logger.info(`[Scheduler] Stop signal received before advert "${advert.jobTitle}". Deferring remaining.`);
          outerStopped = true;
          break;
        }

        if (remainingCandidates.length === 0) break;

        const candidatesForThisAdvert = remainingCandidates.filter(c => advertMatchesHint(advert.jobTitle, c.advertHint));
        const skippedForThisAdvert = remainingCandidates.filter(c => !advertMatchesHint(advert.jobTitle, c.advertHint));

        if (candidatesForThisAdvert.length === 0) {
          logger.info(`Skipping advert "${advert.jobTitle}" — no candidates with matching hint`);
          continue;
        }

        await navigateToManageAdverts(page);
        logger.info(`[Phase 2b] Opening advert "${advert.jobTitle}" (ID: ${advert.advertId})`);
        await navigateToAdvertById(page, advert.advertId, advert.pageNumber);

        const { notFound: stillNotFound, processedCount } = await processGroupInAdvert(
          page,
          candidatesForThisAdvert,
          `advert "${advert.jobTitle}"`,
          shouldStop,
        );

        if (processedCount > 0) {
          advertResults.push({ adrefNo: advert.advertId, advertTitle: advert.jobTitle, candidatesProcessed: processedCount, datePosted: advert.datePosted.toISOString().substring(0, 10) });
        }

        remainingCandidates = [...stillNotFound, ...skippedForThisAdvert];

        if (shouldStop()) {
          outerStopped = true;
          break;
        }

        await randomDelay();
      }

      if (remainingCandidates.length > 0 && !outerStopped) {
        logger.warn(`${remainingCandidates.length} candidate(s) not found after full Phase 2 iteration:`);
        for (const candidate of remainingCandidates) {
          logger.warn(`  - ${candidate.candidateName} (${candidate.candidateEmail}) [Row ${candidate.rowIndex}]`);
          await incrementRowAttempt(candidate.rowIndex, candidate.processed);
          failedCandidates.push({
            name: candidate.candidateName,
            email: candidate.candidateEmail,
            rowIndex: candidate.rowIndex,
            reason: "Not found in any advert after Phase 2 full iteration",
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

    return { failed: failedCandidates, advertResults };
  }

  // --- Phase 1: candidates with adref_no — search directly by adref ---

  const withAdref = processable.filter(c => c.adrefNo.trim().length > 0);
  const fallbackCandidates: CandidateRow[] = processable.filter(c => c.adrefNo.trim().length === 0);

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

    const chosenAdvert = await searchAndNavigateToAdvert(page, adrefNo, advertHint);

    if (!chosenAdvert) {
      logger.warn(`No advert found for adref_no "${adrefNo}" — adding ${group.length} candidate(s) to 30-day fallback`);
      fallbackCandidates.push(...group);
      continue;
    }

    const { notFound: notFoundInAdvert, processedCount } = await processGroupInAdvert(
      page,
      group,
      `adref_no "${adrefNo}"`,
      shouldStop,
    );

    if (processedCount > 0) {
      advertResults.push({ adrefNo, advertTitle: chosenAdvert.jobTitle, candidatesProcessed: processedCount, datePosted: chosenAdvert.datePosted });
    }

    // Candidates not found in the targeted advert fall through to the 30-day iteration
    if (notFoundInAdvert.length > 0) {
      logger.info(`${notFoundInAdvert.length} candidate(s) not found in adref "${adrefNo}" advert — adding to 30-day fallback`);
      fallbackCandidates.push(...notFoundInAdvert);
    }
  }

  // --- Phase 2: fallback — iterate all adverts from last 30 days ---

  if (phase === 'phase1Only') {
    logger.info('Phase 1 only — skipping Phase 2 fallback. Unmatched candidates will be picked up in Stage 2.');
    if (failedCandidates.length > 0) {
      logger.warn(`\n=== FAILED CANDIDATES SUMMARY ===`);
      logger.warn(`Total failed: ${failedCandidates.length}`);
      for (const failed of failedCandidates) {
        logger.warn(`  - ${failed.name} (${failed.email}) [Row ${failed.rowIndex}]: ${failed.reason}`);
      }
    }
    return { failed: failedCandidates, advertResults };
  }

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

      const candidatesForThisAdvert = remainingCandidates.filter(c => advertMatchesHint(advert.jobTitle, c.advertHint));
      const skippedForThisAdvert = remainingCandidates.filter(c => !advertMatchesHint(advert.jobTitle, c.advertHint));

      if (candidatesForThisAdvert.length === 0) {
        logger.info(`Skipping advert "${advert.jobTitle}" — no candidates with matching hint`);
        continue;
      }

      await navigateToManageAdverts(page);
      logger.info(`Opening advert "${advert.jobTitle}" (ID: ${advert.advertId})`);
      await navigateToAdvertById(page, advert.advertId, advert.pageNumber);

      const { notFound: stillNotFound, processedCount } = await processGroupInAdvert(
        page,
        candidatesForThisAdvert,
        `advert "${advert.jobTitle}"`,
        shouldStop,
      );

      if (processedCount > 0) {
        // Phase 2 adverts have no adref_no — use advertId as the reference
        advertResults.push({ adrefNo: advert.advertId, advertTitle: advert.jobTitle, candidatesProcessed: processedCount, datePosted: advert.datePosted.toISOString().substring(0, 10) });
      }

      remainingCandidates = [...stillNotFound, ...skippedForThisAdvert];

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

  return { failed: failedCandidates, advertResults };
}
