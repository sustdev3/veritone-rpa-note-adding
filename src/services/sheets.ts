import { google } from "googleapis";
import logger from "../utils/logger";

export interface CandidateRow {
  rowIndex: number;
  timestamp: string;
  candidateEmail: string;
  candidateName: string;
  adrefNo: string;          // col D (index 3) — used to search for the advert
  advertHint: string;       // col E (index 4) — used to disambiguate adref_no results
  livingInAus: string;      // col F (index 5)
  hasVisa: string;          // col G (index 6)
  suburb: string;           // col H (index 7)
  carLicence: string;       // col I (index 8)
  transport: string;        // col J (index 9)
  fulltimeHours: string;    // col K (index 10)
  immediateStart: string;   // col L (index 11)
  preferredShift: string;   // col M (index 12)
  lastJobEnd: string;       // col N (index 13)
  processed: string;        // col O (index 14)
}

async function getAuthenticatedSheets() {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!serviceAccountEmail) {
    throw new Error("Missing required environment variable: GOOGLE_SERVICE_ACCOUNT_EMAIL");
  }
  if (!privateKey) {
    throw new Error("Missing required environment variable: GOOGLE_PRIVATE_KEY");
  }
  if (!sheetId) {
    throw new Error("Missing required environment variable: GOOGLE_SHEET_ID");
  }

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

function parseSheetTimestamp(ts: string): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

export async function getUnprocessedRows(since?: Date, before?: Date): Promise<CandidateRow[]> {
  if (since && before) {
    logger.info(`Fetching unprocessed rows from ${since.toISOString()} to ${before.toISOString()} from Google Sheets...`);
  } else if (since) {
    logger.info(`Fetching unprocessed rows since ${since.toISOString()} from Google Sheets...`);
  } else if (before) {
    logger.info(`Fetching unprocessed rows before ${before.toISOString()} from Google Sheets...`);
  } else {
    logger.info("Fetching unprocessed rows from Google Sheets...");
  }

  const { sheets, sheetId } = await getAuthenticatedSheets();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A:O",
  });

  const rows = response.data.values || [];
  logger.info(`Found ${rows.length} total rows (including header)`);

  const unprocessedRows: CandidateRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    if (row.length < 4) {
      continue;
    }

    const processedStatus = (row[14] || "").toUpperCase();
    if (processedStatus === "TRUE" || processedStatus === "ERROR" || processedStatus === "SKIPPED" || processedStatus === "OUTSIDE WINDOW") {
      continue;
    }

    if (since || before) {
      const submittedAt = parseSheetTimestamp(row[0] || "");
      if (since && submittedAt && submittedAt < since) continue;
      if (before && submittedAt && submittedAt >= before) continue;
    }

    unprocessedRows.push({
      rowIndex: i + 1,
      timestamp: row[0] || "",
      candidateEmail: row[1] || "",
      candidateName: row[2] || "",
      adrefNo: row[3] || "",
      advertHint: row[4] || "",
      livingInAus: row[5] || "",
      hasVisa: row[6] || "",
      suburb: row[7] || "",
      carLicence: row[8] || "",
      transport: row[9] || "",
      fulltimeHours: row[10] || "",
      immediateStart: row[11] || "",
      preferredShift: row[12] || "",
      lastJobEnd: row[13] || "",
      processed: row[14] || "",
    });
  }

  logger.info(`Found ${unprocessedRows.length} unprocessed rows`);
  return unprocessedRows;
}

export async function markRowAsProcessed(rowIndex: number, value = "TRUE"): Promise<void> {
  logger.info(`Marking row ${rowIndex} as processed (${value})...`);

  const { sheets, sheetId } = await getAuthenticatedSheets();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Sheet1!O${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[value]],
    },
  });

  logger.info(`Row ${rowIndex} marked as processed (${value})`);
}

export async function markRowsAsSkipped(rowIndexes: number[]): Promise<void> {
  if (rowIndexes.length === 0) return;
  logger.info(`Marking ${rowIndexes.length} row(s) as skipped in one batch...`);

  const { sheets, sheetId } = await getAuthenticatedSheets();

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: rowIndexes.map(rowIndex => ({
        range: `Sheet1!O${rowIndex}`,
        values: [["SKIPPED"]],
      })),
    },
  });

  logger.info(`Marked rows ${rowIndexes.join(", ")} as skipped`);
}

export async function incrementRowAttempt(rowIndex: number, currentAttempts: string): Promise<void> {
  const count = parseInt(currentAttempts) || 0;
  const newValue = count >= 2 ? "ERROR" : String(count + 1);
  logger.info(`Incrementing attempt for row ${rowIndex}: ${currentAttempts} → ${newValue}`);

  const { sheets, sheetId } = await getAuthenticatedSheets();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Sheet1!O${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[newValue]],
    },
  });

  logger.info(`Row ${rowIndex} attempt updated to: ${newValue}`);
}

export async function writeAdvertIdToRow(rowIndex: number, advertId: string): Promise<void> {
  const { sheets, sheetId } = await getAuthenticatedSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Sheet1!P${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[advertId]] },
  });
}

export async function markRowAsError(rowIndex: number): Promise<void> {
  logger.info(`Marking row ${rowIndex} as error...`);

  const { sheets, sheetId } = await getAuthenticatedSheets();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Sheet1!O${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["error"]],
    },
  });

  logger.info(`Row ${rowIndex} marked as error`);
}

export async function mergeAnsweredSummary(): Promise<void> {
  logger.info("Writing answered summary from Sheet1 col N...");
  const { sheets, sheetId } = await getAuthenticatedSheets();

  const sheet1Response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A:P",
  });

  // Count respondents per unique advertId (col N only — rows without col N are skipped)
  const counts = new Map<string, number>();
  for (const row of (sheet1Response.data.values || []).slice(1)) {
    const advertId = (row[15] || "").trim();
    if (!advertId) continue;
    counts.set(advertId, (counts.get(advertId) ?? 0) + 1);
  }

  if (counts.size === 0) {
    logger.info("No advertIds recorded in Sheet1 — skipping summary write");
    return;
  }

  const updatedAt = new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "short",
    timeStyle: "short",
  });

  // Col positions kept intact so pre-screening RPA reads col D (count) and col F (advertId) correctly.
  // Cols A-C are empty — note-adding RPA does not have advert metadata.
  const rows = Array.from(counts.entries()).map(([advertId, count]) => [
    "",        // A: adrefNo
    "",        // B: jobTitle
    "",        // C: datePosted
    count,     // D: answeredCount
    updatedAt, // E: updatedAt
    advertId,  // F: advertId
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: "Summary!A2:F",
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Summary!A2",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  logger.info(`Answered summary written — ${counts.size} unique advertId(s)`);
}
