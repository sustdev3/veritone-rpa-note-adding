import dotenv from "dotenv";
import { DateTime } from "luxon";
import logger from "./utils/logger";
import { navigateHome } from "./utils/shared/shared";
import { launchAndLogin, runBatch, logoutAndClose, aestTimestamp } from "./main";
import { sendErrorEmail, sendSuccessReportEmail } from "./services/email";
import { AdvertRunResult } from "./main";
import { mergeAnsweredSummary } from "./services/sheets";

dotenv.config();

const AEST_ZONE = "Australia/Sydney";
const BUSINESS_END_HOUR = 18;
// First run window: 6:45am–7:15am AEST (expressed as minutes from midnight)
const FIRST_RUN_MIN_MINUTES = 6 * 60 + 45;
const FIRST_RUN_MAX_MINUTES = 7 * 60 + 15;
// Between batches: 50–70 minute idle gap
const MIN_GAP_MINUTES = 50;
const MAX_GAP_MINUTES = 70;
// Each batch runs for up to 60 minutes
const BATCH_DURATION_MINUTES = 60;

const IS_TESTING = (process.env.RUN_MODE ?? "testing") === "testing";

process.on("uncaughtException", async (error: Error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  logger.error(`Stack: ${error.stack}`);
  await sendErrorEmail(
    `S1HR RPA — Global Crash: ${error.message}`,
    `${error.message}\n\nStack Trace:\n${error.stack}`,
  );
  process.exit(1);
});

process.on("unhandledRejection", async (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error(`Unhandled Rejection: ${error.message}`);
  logger.error(`Stack: ${error.stack}`);
  await sendErrorEmail(
    `S1HR RPA — Global Crash: ${error.message}`,
    `${error.message}\n\nStack Trace:\n${error.stack}`,
  );
  process.exit(1);
});

function nowAest(): DateTime {
  return DateTime.now().setZone(AEST_ZONE);
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isPastEndOfDay(): boolean {
  if (IS_TESTING) return false;
  return nowAest().hour >= BUSINESS_END_HOUR;
}

function msUntil(target: DateTime): number {
  return Math.max(0, target.toMillis() - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatMinutes(ms: number): string {
  return `${Math.round(ms / 1000 / 60)} minutes`;
}

async function runDay(): Promise<void> {
  logger.info(`[Scheduler] Day session starting at ${aestTimestamp()} AEST`);

  const session = await launchAndLogin();
  const allAdvertResults: AdvertRunResult[] = [];

  try {
    while (true) {
      if (isPastEndOfDay()) {
        logger.info("[Scheduler] Past 6:00pm AEST — ending day session.");
        break;
      }

      const batchStart = Date.now();
      const batchDeadlineMs = batchStart + BATCH_DURATION_MINUTES * 60 * 1000;
      const batchEndTime = nowAest().plus({ minutes: BATCH_DURATION_MINUTES });

      logger.info(
        `[Scheduler] Batch started at ${nowAest().toFormat("HH:mm:ss")} AEST — ` +
        `will run until ${batchEndTime.toFormat("HH:mm:ss")} AEST (or until 6:00pm if sooner)`
      );

      const shouldStop = (): boolean => {
        const batchExpired = Date.now() >= batchDeadlineMs;
        if (batchExpired) {
          logger.info("[Scheduler] 60-minute batch window reached. Finishing current candidate then parking.");
        }
        const endOfDay = isPastEndOfDay();
        if (endOfDay) {
          logger.info("[Scheduler] 6:00pm AEST reached mid-batch. Finishing current candidate then ending day.");
        }
        return batchExpired || endOfDay;
      };

      const batchResults = await runBatch(session, shouldStop);
      if (batchResults) allAdvertResults.push(...batchResults);

      const batchEndedAt = nowAest();
      const batchDurationMs = Date.now() - batchStart;

      if (!batchResults) {
        // Exited early — no candidates in the sheet
        const remainingInWindowMs = batchDeadlineMs - Date.now();

        if (isPastEndOfDay()) {
          logger.info(
            `[Scheduler] No candidates found. It is past 6:00pm AEST — ending day session now.`
          );
          break;
        }

        if (remainingInWindowMs > 0) {
          logger.info(
            `[Scheduler] No candidates found. Exited early at ${batchEndedAt.toFormat("HH:mm:ss")} AEST. ` +
            `${formatMinutes(remainingInWindowMs)} remaining in this batch window — ` +
            `parking and waiting for the batch window to end before the next gap.`
          );
          await navigateHome(session);
          await sleep(remainingInWindowMs);
        } else {
          logger.info(
            `[Scheduler] No candidates found. Batch window already expired — moving straight to next gap.`
          );
        }
      } else {
        logger.info(
          `[Scheduler] Batch finished at ${batchEndedAt.toFormat("HH:mm:ss")} AEST ` +
          `(ran for ${formatMinutes(batchDurationMs)})`
        );
      }


      if (isPastEndOfDay()) {
        logger.info("[Scheduler] Past 6:00pm AEST after batch — ending day session.");
        break;
      }

      await navigateHome(session);

      const gapMinutes = randomBetween(MIN_GAP_MINUTES, MAX_GAP_MINUTES);
      const nextBatchTime = nowAest().plus({ minutes: gapMinutes });
      logger.info(
        `[Scheduler] Next batch at ${nextBatchTime.toFormat("HH:mm:ss")} AEST (in ${gapMinutes} minutes)`
      );
      await sleep(gapMinutes * 60 * 1000);
    }
  } finally {
    logger.info(`[Scheduler] Logging out — day session ended at ${aestTimestamp()} AEST`);
    await sendSuccessReportEmail(allAdvertResults);
    try {
      await mergeAnsweredSummary(allAdvertResults);
    } catch (err) {
      logger.warn(`[Scheduler] WARNING: Failed to write answered summary: ${err}`);
    }
    await logoutAndClose(session);
  }

  scheduleNextDay();
}

function scheduleNextDay(): void {
  const now = nowAest();
  const startMinutes = randomBetween(FIRST_RUN_MIN_MINUTES, FIRST_RUN_MAX_MINUTES);
  const startHour = Math.floor(startMinutes / 60);
  const startMinute = startMinutes % 60;

  let nextDay = now.plus({ days: 1 }).set({
    hour: startHour,
    minute: startMinute,
    second: 0,
    millisecond: 0,
  });

  // Skip weekends (production only)
  if (!IS_TESTING) {
    while (nextDay.weekday === 6 || nextDay.weekday === 7) {
      nextDay = nextDay.plus({ days: 1 });
    }
  }

  const delayMs = msUntil(nextDay);
  logger.info(
    `[Scheduler] Next day session at ${nextDay.toFormat("yyyy-MM-dd HH:mm:ss")} AEST ` +
    `(in ${formatMinutes(delayMs)})`
  );

  setTimeout(runDay, delayMs);
}

function start(): void {
  if (IS_TESTING) {
    logger.info("[Scheduler] RUN_MODE=testing — skipping business-hours window, starting immediately.");
    runDay();
    return;
  }

  const now = nowAest();
  const startMinutes = randomBetween(FIRST_RUN_MIN_MINUTES, FIRST_RUN_MAX_MINUTES);
  const startHour = Math.floor(startMinutes / 60);
  const startMinute = startMinutes % 60;

  const todayStart = now.set({ hour: startHour, minute: startMinute, second: 0, millisecond: 0 });

  if (isPastEndOfDay()) {
    logger.info("[Scheduler] Started after 6:00pm AEST — scheduling for next business day.");
    scheduleNextDay();
    return;
  }

  if (now < todayStart) {
    const delayMs = msUntil(todayStart);
    logger.info(
      `[Scheduler] First session today at ${todayStart.toFormat("HH:mm:ss")} AEST ` +
      `(in ${formatMinutes(delayMs)})`
    );
    setTimeout(runDay, delayMs);
    return;
  }

  logger.info("[Scheduler] Started during business hours — beginning day session immediately.");
  runDay();
}

start();
