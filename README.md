# veritone-rpa-note-adding

Automates adding candidate screening notes into the [AD Courier](https://adcourier.com) recruitment platform on behalf of S1HR. The RPA reads unprocessed rows from a Google Sheet, logs into AD Courier via a headless browser, locates each candidate under their job advert, and inserts the screening note. Processed rows are marked in the sheet and a failure summary email is sent if any candidates could not be completed.

---

## Features

- **Google Sheets integration** — reads candidate data and writes back processed/error status
- **Playwright browser automation** — headless Chromium login, advert navigation, and note entry
- **Multi-advert fallback** — if a candidate isn't found in the first advert result, tries subsequent results automatically
- **Retry logic** — up to 3 attempts per candidate before marking as errored
- **Email notifications** — sends a failure summary via Gmail SMTP after each run; also fires on breaking/unhandled errors
- **Business-hours scheduler** — self-pacing scheduler runs during AEST business hours with randomised intervals
- **Session-scoped logging** — `logs/rpa.log` always reflects the most recent run only

---

## Project Structure

```
src/
├── main.ts                          # Entry point; exports runRpa()
├── scheduler.ts                     # Business-hours scheduler (AEST)
├── automation/
│   ├── login.ts                     # AD Courier login
│   ├── adverts.ts                   # Advert search and navigation
│   └── responses.ts                 # Candidate lookup and note insertion
├── orchestration/
│   └── candidate-processesor.ts    # Groups candidates by advert; retry logic
├── services/
│   ├── email.ts                     # Nodemailer Gmail wrapper
│   └── sheets.ts                    # Google Sheets API integration
└── utils/
    ├── browser.ts                   # Playwright browser lifecycle
    ├── logger.ts                    # Winston logger + resetLogFile()
    └── shared/
        └── shared.ts                # randomDelay(), BrowserSession, cleanupSession()
```

---

## Prerequisites

- **Node.js** 18+
- **Playwright** Chromium (installed automatically via `npx playwright install chromium`)
- A **Google Cloud service account** with Sheets API access and the sheet shared to its email
- A **Gmail account** with an [App Password](https://support.google.com/accounts/answer/185833) for SMTP

---

## Setup

1. Clone the repository and install dependencies:

```bash
npm install
npx playwright install chromium
```

2. Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

`.env` fields:

| Variable | Description |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email |
| `GOOGLE_PRIVATE_KEY` | Service account private key (include `\n` line breaks) |
| `GOOGLE_SHEET_ID` | ID from the Google Sheet URL |
| `ADCOURIER_EMAIL` | AD Courier login email |
| `ADCOURIER_PASSWORD` | AD Courier login password |
| `EMAIL_USER` | Gmail address for outbound notifications |
| `EMAIL_PASS` | Gmail App Password (not your account password) |

> Email variables are optional. If omitted, email notifications are silently skipped.

---

## Running

### One-off run

```bash
npm run dev          # TypeScript (development)
npm run build && npm start   # Compiled JS (production)
```

### Scheduled run (AEST business hours)

```bash
npm run schedule              # TypeScript (development)
npm run build && npm run start:schedule   # Compiled JS (production)
```

The scheduler:
- Fires the **first run** at a random time between **6:45am and 7:15am AEST**
- Waits a **random 50–70 minutes** between subsequent runs
- Stops scheduling new runs once a run would begin at or after **6:00pm AEST**
- Automatically skips weekends and resumes the next weekday morning
- If started mid-business-day, waits a random 50–70 minutes before the first run

---

## Logging

Logs are written to `logs/rpa.log` and to the console. The log file is **reset after each successful login**, so it always contains the output of the current session only. Log files are excluded from version control.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Candidate not found after 3 retries | Marked `error` in sheet; included in failure summary email |
| Breaking error inside `runRpa()` | Error email sent with full stack trace |
| Unhandled exception / rejection (direct run) | Crash email sent; process exits |
| Email credentials missing | Warning logged; email skipped silently |

---

## Tests

There are currently no automated tests. The RPA is validated by running against a live browser and Google Sheet.

---

## Tech Stack

| Package | Purpose |
|---|---|
| `playwright` | Browser automation |
| `googleapis` | Google Sheets read/write |
| `winston` | Structured logging |
| `nodemailer` | Gmail SMTP notifications |
| `luxon` | AEST timezone handling in scheduler |
| `dotenv` | Environment variable loading |
| `tsx` / `typescript` | TypeScript execution and compilation |
