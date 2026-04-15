import { Page } from "playwright";
import logger from "../utils/logger";
import { navigateToAdvert } from "../automation/adverts";
import { openResponsesTab, findAndProcessCandidate } from "../automation/responses";
import { CandidateRow, markRowAsProcessed, markRowAsError } from "../services/sheets";
import { randomDelay } from "../utils/shared/shared";

interface FailedCandidate {
  name: string;
  email: string;
  rowIndex: number;
  error: string;
}

export async function processAllCandidatesByAdvert(
  page: Page,
  candidates: CandidateRow[],
  shouldStop: () => boolean = () => false,
): Promise<FailedCandidate[]> {
  const failedCandidates: FailedCandidate[] = [];

  // Group candidates by advert title
  const groupedByAdvert = new Map<string, CandidateRow[]>();
  for (const candidate of candidates) {
    const group = groupedByAdvert.get(candidate.advertTitle) ?? [];
    group.push(candidate);
    groupedByAdvert.set(candidate.advertTitle, group);
  }

  // Process each advert and its candidates
  for (const [advertTitle, group] of groupedByAdvert) {
    if (shouldStop()) {
      logger.info(`[Scheduler] Stop signal received before advert "${advertTitle}". Deferring remaining candidates to next run.`);
      break;
    }

    logger.info(`Processing advert: "${advertTitle}" with ${group.length} candidate(s)`);

    let remainingCandidates = [...group];
    let resultIndex = 0;
    let totalResults = 0;
    let stopped = false;

    while (remainingCandidates.length > 0 && !stopped) {
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
      const processedInThisRound: CandidateRow[] = [];

      for (const candidate of remainingCandidates) {
        if (shouldStop()) {
          logger.info(`[Scheduler] Stop signal received after finishing previous candidate. Deferring "${candidate.candidateName}" and remaining to next run.`);
          stopped = true;
          break;
        }

        logger.info(
          `Searching for candidate: ${candidate.candidateName} (${candidate.candidateEmail})`,
        );

        let retryCount = 0;
        const maxRetries = 3;
        let processed = false;

        while (retryCount < maxRetries && !processed) {
          try {
            const found = await findAndProcessCandidate(
              page,
              candidate.candidateEmail,
              candidate,
            );

            if (found) {
              logger.info(`✓ Found candidate ${candidate.candidateName} in advert responses.`);
              await markRowAsProcessed(candidate.rowIndex);
              logger.info(`Marked row ${candidate.rowIndex} as processed in Google Sheet.`);
              processedInThisRound.push(candidate);
              processed = true;
            } else {
              logger.warn(`✗ Candidate ${candidate.candidateName} not found in this result.`);
              notFound.push(candidate);
              processed = true;
            }
          } catch (error) {
            const errorMessage = (error as Error).message;
            retryCount++;

            if (errorMessage.toLowerCase().includes('timeout')) {
              logger.error(
                `Timeout error processing candidate ${candidate.candidateName}: ${errorMessage}. Retry ${retryCount}/${maxRetries}`,
              );
            } else {
              logger.error(
                `Error processing candidate ${candidate.candidateName}: ${errorMessage}. Retry ${retryCount}/${maxRetries}`,
              );
            }

            if (retryCount < maxRetries) {
              await randomDelay();
            } else {
              logger.warn(
                `Failed to process candidate ${candidate.candidateName} (${candidate.candidateEmail}) after ${maxRetries} attempts`,
              );
              await markRowAsError(candidate.rowIndex);
              failedCandidates.push({
                name: candidate.candidateName,
                email: candidate.candidateEmail,
                rowIndex: candidate.rowIndex,
                error: errorMessage,
              });
              processed = true;
            }
          }
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

  // Log summary of failed candidates
  if (failedCandidates.length > 0) {
    logger.warn(`\n=== FAILED CANDIDATES SUMMARY ===`);
    logger.warn(`Total failed: ${failedCandidates.length}`);
    for (const failed of failedCandidates) {
      logger.warn(
        `  - ${failed.name} (${failed.email}) [Row ${failed.rowIndex}]: ${failed.error}`,
      );
    }
  }

  return failedCandidates;
}
