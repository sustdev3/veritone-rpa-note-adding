import fs from "fs";
import path from "path";
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
const STAGE1_END_HOUR = 15;  // 3:00 PM AEST
const STAGE2_END_HOUR = parseInt(process.env.STAGE2_END_HOUR ?? "20", 10);  // 8:00 PM AEST default
// First run window: 6:45am–7:15am AEST (expressed as minutes from midnight)
const FIRST_RUN_MIN_MINUTES = 6 * 60 + 45;
const FIRST_RUN_MAX_MINUTES = 7 * 60 + 15;
// Between batches: 50–70 minute idle gap
const MIN_GAP_MINUTES = 50;
const MAX_GAP_MINUTES = 70;
// Each Stage 1 batch runs for up to 60 minutes
const BATCH_DURATION_MINUTES = 60;

const STATE_FILE = path.resolve(process.cwd(), ".rpa-state.json");

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

function isPastStage1End(): boolean {
  if (IS_TESTING) return false;
  return nowAest().hour >= STAGE1_END_HOUR;
}

function isPastStage2End(): boolean {
  if (IS_TESTING) return false;
  return nowAest().hour >= STAGE2_END_HOUR;
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

function readLastBatchStart(): Date | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const { lastBatchStartISO } = JSON.parse(raw);
    const d = new Date(lastBatchStartISO);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function writeLastBatchStart(time: DateTime): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastBatchStartISO: time.toISO() }), "utf-8");
  } catch (err) {
    logger.warn(`[Scheduler] WARNING: Failed to write state file: ${err}`);
  }
}

async function runDay(): Promise<void> {
  logger.info(`[Scheduler] Day session starting at ${aestTimestamp()} AEST`);

  const session = await launchAndLogin();
  const allAdvertResults: AdvertRunResult[] = [];

  try {
    // ── Stage 1: Phase 1 only, hourly batches, 6:45 AM – 3:00 PM ──────────────

    while (!isPastStage1End()) {
      const batchStart = Date.now();
      const batchStartTime = nowAest();
      const batchDeadlineMs = batchStart + BATCH_DURATION_MINUTES * 60 * 1000;
      const batchEndTime = batchStartTime.plus({ minutes: BATCH_DURATION_MINUTES });

      logger.info(
        `[Scheduler] Stage 1 batch started at ${batchStartTime.toFormat("HH:mm:ss")} AEST — ` +
        `will run until ${batchEndTime.toFormat("HH:mm:ss")} AEST (or 3:00 PM if sooner)`
      );

      const shouldStop = (): boolean => {
        const batchExpired = Date.now() >= batchDeadlineMs;
        if (batchExpired) {
          logger.info("[Scheduler] 60-minute Stage 1 batch window reached. Finishing current candidate then parking.");
        }
        const stage1End = isPastStage1End();
        if (stage1End) {
          logger.info("[Scheduler] 3:00 PM AEST reached mid-batch. Finishing current candidate then moving to Stage 2.");
        }
        return batchExpired || stage1End;
      };

      const since = readLastBatchStart() ?? undefined;
      const batchResults = await runBatch(session, shouldStop, 'phase1Only', since);
      writeLastBatchStart(batchStartTime);

      if (batchResults) allAdvertResults.push(...batchResults);

      const batchEndedAt = nowAest();
      const batchDurationMs = Date.now() - batchStart;

      if (isPastStage1End()) {
        logger.info("[Scheduler] Past 3:00 PM AEST after Stage 1 batch — moving to Stage 2.");
        break;
      }

      if (!batchResults) {
        const remainingInWindowMs = batchDeadlineMs - Date.now();

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
          `[Scheduler] Stage 1 batch finished at ${batchEndedAt.toFormat("HH:mm:ss")} AEST ` +
          `(ran for ${formatMinutes(batchDurationMs)})`
        );
      }

      if (isPastStage1End()) {
        logger.info("[Scheduler] Past 3:00 PM AEST — moving to Stage 2.");
        break;
      }

      await navigateHome(session);

      const gapMinutes = randomBetween(MIN_GAP_MINUTES, MAX_GAP_MINUTES);
      const nextBatchTime = nowAest().plus({ minutes: gapMinutes });

      if (nextBatchTime.hour >= STAGE1_END_HOUR) {
        logger.info(
          `[Scheduler] Next Stage 1 batch would start at ${nextBatchTime.toFormat("HH:mm:ss")} AEST, ` +
          `past Stage 1 cutoff (3:00 PM) — skipping sleep, moving directly to Stage 2.`
        );
        break;
      }

      logger.info(
        `[Scheduler] Next Stage 1 batch at ${nextBatchTime.toFormat("HH:mm:ss")} AEST (in ${gapMinutes} minutes)`
      );
      await sleep(gapMinutes * 60 * 1000);
    }

    // ── Stage 2: Phase 2 only, full backlog pass, 3:00 PM – 8:00 PM ───────────

    if (!isPastStage2End()) {
      logger.info(`[Scheduler] Starting Stage 2 (Phase 2 fallback) at ${nowAest().toFormat("HH:mm:ss")} AEST`);

      // Fresh session for Stage 2
      await logoutAndClose(session);
      const stage2Session = await launchAndLogin();

      try {
        const stage2ShouldStop = (): boolean => {
          const past = isPastStage2End();
          if (past) {
            logger.info("[Scheduler] 8:00 PM AEST reached during Stage 2. Finishing current candidate then ending.");
          }
          return past;
        };

        // Stage 2 processes the full unprocessed backlog up to (but not including) today —
        // same-day candidates are handled by Stage 1 and will fall to tomorrow's Stage 2 if unmatched
        const startOfToday = nowAest().startOf('day').toJSDate();
        const stage2Results = await runBatch(stage2Session, stage2ShouldStop, 'phase2Only', undefined, startOfToday);
        if (stage2Results) allAdvertResults.push(...stage2Results);

        logger.info(`[Scheduler] Stage 2 complete at ${nowAest().toFormat("HH:mm:ss")} AEST`);
      } finally {
        await logoutAndClose(stage2Session);
      }
    } else {
      logger.info("[Scheduler] Past 8:00 PM AEST — Stage 2 skipped.");
      await logoutAndClose(session);
    }

  } catch (err) {
    logger.error(`[Scheduler] Unexpected error in runDay: ${err}`);
    try { await logoutAndClose(session); } catch { /* ignore */ }
    throw err;
  }

  // ── End of day ──────────────────────────────────────────────────────────────

  logger.info(`[Scheduler] Day session ended at ${aestTimestamp()} AEST`);
  await sendSuccessReportEmail(allAdvertResults);

  try {
    await mergeAnsweredSummary();
  } catch (err) {
    logger.warn(`[Scheduler] WARNING: Failed to write answered summary: ${err}`);
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

  if (isPastStage2End()) {
    logger.info("[Scheduler] Started after 8:00 PM AEST — scheduling for next business day.");
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
