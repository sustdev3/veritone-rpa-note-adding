import { Page } from "playwright";
import logger from "../utils/logger";
import { navigateToAdvert } from "../automation/adverts";
import { openResponsesTab, findAndProcessCandidate } from "../automation/responses";
import { CandidateRow, markRowAsProcessed } from "../services/sheets";
import { randomDelay } from "../utils/shared/shared";

export async function processAllCandidatesByAdvert(
  page: Page,
  candidates: CandidateRow[],
): Promise<void> {
  // Group candidates by advert title
  const groupedByAdvert = new Map<string, CandidateRow[]>();
  for (const candidate of candidates) {
    const group = groupedByAdvert.get(candidate.advertTitle) ?? [];
    group.push(candidate);
    groupedByAdvert.set(candidate.advertTitle, group);
  }

  // Process each advert and its candidates
  for (const [advertTitle, group] of groupedByAdvert) {
    logger.info(`Processing advert: "${advertTitle}" with ${group.length} candidate(s)`);

    let remainingCandidates = [...group];
    let resultIndex = 0;
    let totalResults = 0;

    while (remainingCandidates.length > 0) {
      const { advertId, totalResults: total } = await navigateToAdvert(
        page,
        advertTitle,
        resultIndex,
      );
      totalResults = total;
      logger.info(`Navigated to advert with ID: ${advertId}`);

      await randomDelay();
      await openResponsesTab(page);

      const notFound: CandidateRow[] = [];

      for (const candidate of remainingCandidates) {
        logger.info(
          `Searching for candidate: ${candidate.candidateName} (${candidate.candidateEmail})`,
        );

        const found = await findAndProcessCandidate(
          page,
          candidate.candidateEmail,
        );

        if (found) {
          logger.info(`✓ Found candidate ${candidate.candidateName} in advert responses.`);
          await markRowAsProcessed(candidate.rowIndex);
          logger.info(`Marked row ${candidate.rowIndex} as processed in Google Sheet.`);
        } else {
          logger.warn(`✗ Candidate ${candidate.candidateName} not found in this result.`);
          notFound.push(candidate);
        }

        await randomDelay();
      }

      remainingCandidates = notFound;
      resultIndex++;

      if (resultIndex >= totalResults || remainingCandidates.length === 0) {
        break;
      }

      logger.info(
        `Trying next advert result (${resultIndex + 1}/${totalResults}) for remaining ${remainingCandidates.length} candidate(s)...`,
      );
    }

    // Log final status for this advert
    if (remainingCandidates.length > 0) {
      logger.warn(
        `Final: ${remainingCandidates.length} candidate(s) not found in any advert result for "${advertTitle}":`,
      );
      for (const candidate of remainingCandidates) {
        logger.warn(`  - ${candidate.candidateName} (${candidate.candidateEmail})`);
      }
    }
  }
}
