/**
 * One-time backfill script: writes advertId to col N for previously processed candidates
 * that are missing it.
 *
 * Logic: for each "TRUE" row missing col N, find another row with the same
 * adrefNo + advertHint that already has col N — use that advertId.
 * If a key maps to more than one distinct advertId, skip it (ambiguous).
 *
 * Run from project root:
 *   npx tsx backfill-advert-id.ts
 */

import * as dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

async function getSheets() {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!serviceAccountEmail) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL");
  if (!privateKey) throw new Error("Missing GOOGLE_PRIVATE_KEY");
  if (!sheetId) throw new Error("Missing GOOGLE_SHEET_ID");

  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: "service_account",
      project_id: "veritone-rpa",
      private_key_id: "key1",
      private_key: privateKey.replace(/\\n/g, "\n"),
      client_email: serviceAccountEmail,
      client_id: "1",
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return { sheets: google.sheets({ version: "v4", auth }), sheetId };
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("--- DRY RUN — no writes will be made ---\n");

  const { sheets, sheetId } = await getSheets();

  const BACKFILL_MAX_ROW = 2638;

  console.log(`Reading full Sheet1!A:N (backfill limited to rows 2–${BACKFILL_MAX_ROW})...`);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A:N",
  });

  const rows = (response.data.values || []).slice(1); // skip header
  console.log(`Total data rows: ${rows.length}`);

  // Build adrefNo|advertHint → advertId from rows that already have col N
  const peerMap = new Map<string, string>();
  const ambiguousKeys = new Set<string>();

  for (const row of rows) {
    const advertId = (row[13] || "").trim();
    if (!advertId) continue;

    const adrefNo = (row[3] || "").trim();
    const advertHint = (row[4] || "").trim();
    if (!adrefNo || !advertHint) continue;

    const key = `${adrefNo}|${advertHint}`;
    const existing = peerMap.get(key);

    if (existing && existing !== advertId) {
      ambiguousKeys.add(key);
    } else {
      peerMap.set(key, advertId);
    }
  }

  // Remove ambiguous keys — two different advertIds for the same key
  for (const key of ambiguousKeys) {
    peerMap.delete(key);
    console.warn(`Skipping ambiguous key: ${key}`);
  }

  console.log(`Peer map built: ${peerMap.size} unique adrefNo|hint → advertId mappings`);

  // Find rows that need backfilling
  const toBackfill: Array<{ rowIndex: number; adrefNo: string; advertHint: string; advertId: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowIndex = i + 2; // +1 for 0-based, +1 for header row
    if (rowIndex > BACKFILL_MAX_ROW) continue; // only backfill historical rows

    const processed = (row[12] || "").trim().toUpperCase();
    if (processed !== "TRUE") continue;

    const advertId = (row[13] || "").trim();
    if (advertId) continue; // already has col N

    const adrefNo = (row[3] || "").trim();
    const advertHint = (row[4] || "").trim();
    if (!adrefNo || !advertHint) continue;

    const key = `${adrefNo}|${advertHint}`;
    const inferredAdvertId = peerMap.get(key);
    if (!inferredAdvertId) continue;

    toBackfill.push({ rowIndex, adrefNo, advertHint, advertId: inferredAdvertId });
  }

  // Preview
  console.log(`\nRows to backfill: ${toBackfill.length}`);
  if (toBackfill.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  console.log("\nSample (first 10):");
  for (const entry of toBackfill.slice(0, 10)) {
    console.log(`  Row ${entry.rowIndex}: adrefNo=${entry.adrefNo}, hint="${entry.advertHint}" → advertId=${entry.advertId}`);
  }

  if (dryRun) {
    console.log("\nDry run complete — nothing written.");
    return;
  }

  // Confirm before writing
  console.log(`\nAbout to write ${toBackfill.length} advertId(s) to col N. Press Ctrl+C within 5 seconds to cancel...`);
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Batch write
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: toBackfill.map(({ rowIndex, advertId }) => ({
        range: `Sheet1!N${rowIndex}`,
        values: [[advertId]],
      })),
    },
  });

  console.log(`Done — wrote advertId to ${toBackfill.length} rows.`);
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
