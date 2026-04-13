import { google } from "googleapis";
import logger from "../utils/logger";

export interface CandidateRow {
  rowIndex: number;
  timestamp: string;
  candidateEmail: string;
  candidateName: string;
  advertTitle: string;
  suburb: string;
  carLicence: string;
  fulltimeHours: string;
  immediateStart: string;
  preferredShift: string;
  processed: string;
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
    range: "Sheet1!A:J",
  });

  const rows = response.data.values || [];
  logger.info(`Found ${rows.length} total rows (including header)`);

  const unprocessedRows: CandidateRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    if (row.length < 4) {
      continue;
    }

    const processedStatus = (row[9] || "").toUpperCase();
    if (processedStatus === "TRUE") {
      continue;
    }

    unprocessedRows.push({
      rowIndex: i + 1,
      timestamp: row[0] || "",
      candidateEmail: row[1] || "",
      candidateName: row[2] || "",
      advertTitle: row[3] || "",
      suburb: row[4] || "",
      carLicence: row[5] || "",
      fulltimeHours: row[6] || "",
      immediateStart: row[7] || "",
      preferredShift: row[8] || "",
      processed: row[9] || "",
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
    range: `Sheet1!J${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["TRUE"]],
    },
  });

  logger.info(`Row ${rowIndex} marked as processed`);
}
