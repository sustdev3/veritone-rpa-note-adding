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

export async function getUnprocessedRows(): Promise<CandidateRow[]> {
  logger.info("Fetching unprocessed rows from Google Sheets...");

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
    if (processedStatus === "TRUE" || processedStatus === "ERROR") {
      continue;
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
