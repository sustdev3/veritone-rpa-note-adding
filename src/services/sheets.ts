import { google } from "googleapis";
import logger from "../utils/logger";

export interface CandidateRow {
  rowIndex: number;
  timestamp: string;
  candidateEmail: string;
  candidateName: string;
  adrefNo: string;          // col D (index 3) — used to search for the advert
  advertHint: string;       // col E (index 4) — used to disambiguate adref_no results
  suburb: string;
  carLicence: string;
  transport: string;
  fulltimeHours: string;
  immediateStart: string;
  preferredShift: string;
  lastJobEnd: string;
  processed: string;        // col M (index 12)
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

export async function getUnprocessedRows(since?: Date): Promise<CandidateRow[]> {
  if (since) {
    logger.info(`Fetching unprocessed rows since ${since.toISOString()} from Google Sheets...`);
  } else {
    logger.info("Fetching unprocessed rows from Google Sheets...");
  }

  const { sheets, sheetId } = await getAuthenticatedSheets();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A:M",
  });

  const rows = response.data.values || [];
  logger.info(`Found ${rows.length} total rows (including header)`);

  const unprocessedRows: CandidateRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    if (row.length < 4) {
      continue;
    }

    const processedStatus = (row[12] || "").toUpperCase();
    if (processedStatus === "TRUE" || processedStatus === "ERROR" || processedStatus === "SKIPPED") {
      continue;
    }

    if (since) {
      const submittedAt = parseSheetTimestamp(row[0] || "");
      if (submittedAt && submittedAt < since) {
        continue;
      }
    }

    unprocessedRows.push({
      rowIndex: i + 1,
      timestamp: row[0] || "",
      candidateEmail: row[1] || "",
      candidateName: row[2] || "",
      adrefNo: row[3] || "",
      advertHint: row[4] || "",
      suburb: row[5] || "",
      carLicence: row[6] || "",
      transport: row[7] || "",
      fulltimeHours: row[8] || "",
      immediateStart: row[9] || "",
      preferredShift: row[10] || "",
      lastJobEnd: row[11] || "",
      processed: row[12] || "",
    });
  }

  logger.info(`Found ${unprocessedRows.length} unprocessed rows`);
  return unprocessedRows;
}

export async function markRowAsProcessed(rowIndex: number): Promise<void> {
  logger.info(`Marking row ${rowIndex} as processed...`);

  const { sheets, sheetId } = await getAuthenticatedSheets();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Sheet1!M${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["TRUE"]],
    },
  });

  logger.info(`Row ${rowIndex} marked as processed`);
}

export async function markRowAsSkipped(rowIndex: number): Promise<void> {
  logger.info(`Marking row ${rowIndex} as skipped...`);

  const { sheets, sheetId } = await getAuthenticatedSheets();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Sheet1!M${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["SKIPPED"]],
    },
  });

  logger.info(`Row ${rowIndex} marked as skipped`);
}

export async function incrementRowAttempt(rowIndex: number, currentAttempts: string): Promise<void> {
  const count = parseInt(currentAttempts) || 0;
  const newValue = count >= 2 ? "ERROR" : String(count + 1);
  logger.info(`Incrementing attempt for row ${rowIndex}: ${currentAttempts} → ${newValue}`);

  const { sheets, sheetId } = await getAuthenticatedSheets();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Sheet1!M${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[newValue]],
    },
  });

  logger.info(`Row ${rowIndex} attempt updated to: ${newValue}`);
}

export async function markRowAsError(rowIndex: number): Promise<void> {
  logger.info(`Marking row ${rowIndex} as error...`);

  const { sheets, sheetId } = await getAuthenticatedSheets();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Sheet1!M${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["error"]],
    },
  });

  logger.info(`Row ${rowIndex} marked as error`);
}

export async function mergeAnsweredSummary(
  advertList: Array<{ advertId: string; refNumber: string; jobTitle: string; datePosted: Date }>,
): Promise<void> {
  if (advertList.length === 0) {
    logger.info("No adverts in advert list — skipping summary write");
    return;
  }

  logger.info(`Writing answered summary from ${advertList.length} advert(s) in lookback window...`);
  const { sheets, sheetId } = await getAuthenticatedSheets();

  // Build adrefNo → Set<jobTitle> from the advert list (authoritative source from Veritone).
  // Adverts without a refNumber are included in the Summary but can't be matched to Sheet1 respondents.
  const adrefToTitles = new Map<string, Set<string>>();
  for (const advert of advertList) {
    if (!advert.refNumber) continue;
    const titles = adrefToTitles.get(advert.refNumber) ?? new Set();
    titles.add(advert.jobTitle);
    adrefToTitles.set(advert.refNumber, titles);
  }

  // Count ALL form respondents from Sheet1 using hint matching.
  const sheet1Response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A:E",
  });

  const respondentCounts = new Map<string, number>();

  for (const row of (sheet1Response.data.values || []).slice(1)) {
    const adrefNo = (row[3] || "").trim();
    const advertHint = (row[4] || "").trim().toLowerCase();
    if (!adrefNo) continue;

    const titles = adrefToTitles.get(adrefNo);
    if (!titles || titles.size <= 1) {
      respondentCounts.set(adrefNo, (respondentCounts.get(adrefNo) ?? 0) + 1);
    } else {
      const titlesArr = Array.from(titles);
      const matched = (() => {
        if (advertHint.length === 0) return titlesArr[0];
        const hintMatches = titlesArr.filter((t) => t.toLowerCase().includes(advertHint));
        if (hintMatches.length === 0) return titlesArr[0];
        if (hintMatches.length === 1) return hintMatches[0];
        return hintMatches.find((t) => t.toLowerCase().startsWith(advertHint)) ?? hintMatches[0];
      })();
      const key = `${adrefNo}|${matched}`;
      respondentCounts.set(key, (respondentCounts.get(key) ?? 0) + 1);
    }
  }

  const getCount = (adrefNo: string, jobTitle: string): number => {
    if (!adrefNo) return 0;
    const titles = adrefToTitles.get(adrefNo);
    if (!titles || titles.size <= 1) return respondentCounts.get(adrefNo) ?? 0;
    return respondentCounts.get(`${adrefNo}|${jobTitle}`) ?? 0;
  };

  // Deduplicate advert list by refNumber|jobTitle (same job may appear as multiple advertIds).
  // For duplicates keep the most recent datePosted.
  const summaryMap = new Map<string, { adrefNo: string; jobTitle: string; datePosted: string }>();
  for (const advert of advertList) {
    const adrefNo = advert.refNumber || advert.advertId;
    const key = `${adrefNo}|${advert.jobTitle}`;
    const dateStr = advert.datePosted.toISOString().substring(0, 10);
    const existing = summaryMap.get(key);
    if (!existing || dateStr > existing.datePosted) {
      summaryMap.set(key, { adrefNo, jobTitle: advert.jobTitle, datePosted: dateStr });
    }
  }

  const updatedAt = new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "short",
    timeStyle: "short",
  });

  const rows = Array.from(summaryMap.values()).map((e) => [
    e.adrefNo,
    e.jobTitle,
    e.datePosted,
    getCount(e.adrefNo, e.jobTitle),
    updatedAt,
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: "Summary!A2:E",
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "Summary!A2",
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
  }

  logger.info(`Answered summary written — ${summaryMap.size} advert(s) tracked`);
}
