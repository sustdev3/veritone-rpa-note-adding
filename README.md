# veritone-rpa-note-adding

Automates adding candidate screening notes into the [AD Courier](https://adcourier.com) recruitment platform on behalf of S1HR. The RPA reads unprocessed rows from a Google Sheet, logs into AD Courier via a headless browser, locates each candidate under their job advert, and inserts the screening note. Processed rows are marked in the sheet and a failure summary email is sent if any candidates could not be completed.

---

## Features

- **Google Sheets integration** — reads candidate data and writes back processed/error status
- **Playwright browser automation** — headless Chromium login, advert navigation, and note entry
- **adref_no search** — searches for the advert directly by reference number, filtered to the lookback window, with hint-based disambiguation when multiple results exist
- **Full iteration fallback** — if adref_no search yields no valid result, iterates all adverts posted within `LOOKBACK_DAYS` and checks each one for the candidate
- **3-strike attempt tracking** — candidates not found increment a counter (`1` → `2` → `ERROR`) across runs rather than failing immediately
- **Email notifications** — sends a per-advert run report at end of day and a failure summary after any batch with errors; also fires on breaking/unhandled errors
- **Business-hours scheduler** — self-pacing scheduler runs during AEST business hours with randomised intervals; bypassed in testing mode
- **Session-scoped logging** — `logs/rpa.log` always reflects the most recent session only

---

## Project Structure

```
src/
├── main.ts                          # Shared functions (launchAndLogin, runBatch, logoutAndClose)
├── scheduler.ts                     # Entry point — business-hours scheduler (AEST)
├── automation/
│   ├── login.ts                     # AD Courier login
│   ├── adverts.ts                   # adref_no search, date filtering, hint matching, full iteration
│   └── responses.ts                 # Candidate lookup and note insertion
├── orchestration/
│   └── candidate-processesor.ts    # Phase 1 (adref_no) and Phase 2 (fallback) orchestration
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
- **Playwright** Chromium (installed via `npx playwright install chromium`)
- A **Google Cloud service account** with Sheets API access and the sheet shared to its email
- A **Gmail account** with an [App Password](https://support.google.com/accounts/answer/185833) for SMTP

---

## Setup

1. Clone the repository and install dependencies:

```bash
npm install
npx playwright install chromium
```

2. Copy the template and fill in your credentials:

```bash
cp .env.template .env
```

| Variable | Description |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email |
| `GOOGLE_PRIVATE_KEY` | Service account private key (include `\n` line breaks) |
| `GOOGLE_SHEET_ID` | ID from the Google Sheet URL |
| `ADCOURIER_EMAIL` | AD Courier login email |
| `ADCOURIER_PASSWORD` | AD Courier login password |
| `EMAIL_USER` | Gmail address for outbound notifications |
| `EMAIL_PASS` | Gmail App Password (not your account password) |
| `RUN_MODE` | `testing` (start immediately) or `production` (enforce 7am–6pm AEST) |
| `LOOKBACK_DAYS` | Days back to search for adverts in both phases (default: `30`) |

> `EMAIL_USER` and `EMAIL_PASS` are optional — if omitted, email notifications are silently skipped.

---

## Running

### Locally (testing)

`.env` ships with `RUN_MODE=testing` — the scheduler starts immediately without waiting for business hours.

```bash
npm run dev
```

### Production (GCP)

Set `RUN_MODE=production` in `.env` before deploying.

```bash
npm run build
pm2 start dist/src/scheduler.js --name s1hr-rpa
pm2 save
pm2 startup
```

---

## Candidate Processing Flow

Each batch runs two phases:

### Phase 1 — adref_no search

Candidates are grouped by `adref_no`. For each group:

1. Search Manage Adverts by `adref_no`
2. Filter results to those posted within `LOOKBACK_DAYS`
3. No results within window → group falls through to Phase 2
4. Among valid results, find the advert whose title contains `advert_hint`
5. No hint match → use the most recent result (with a warning logged)
6. Open the Responses tab, find each candidate by email, add note, mark row `TRUE`
7. Candidate not found in that advert → falls through to Phase 2

### Phase 2 — full iteration fallback

For candidates with no `adref_no`, or those not found in Phase 1:

1. Paginate through all adverts posted within `LOOKBACK_DAYS`
2. Open each advert and search remaining candidates by email
3. Stops early once all remaining candidates are found
4. Still not found after all adverts → attempt counter incremented in the sheet

### Attempt tracking

| Value in col M | Meaning |
|---|---|
| `""` | Not yet attempted |
| `"1"` | Failed 1st batch — will retry |
| `"2"` | Failed 2nd batch — will retry |
| `"ERROR"` | Failed 3rd batch — excluded from future runs, flagged for manual review |

---

## Google Sheet Columns

Range: `Sheet1!A:M`

| Col | Field |
|---|---|
| A | timestamp |
| B | candidate_email |
| C | candidate_name |
| D | adref_no |
| E | advert_hint |
| F | suburb |
| G | car_licence |
| H | transport |
| I | fulltime_hours |
| J | immediate_start |
| K | preferred_shift |
| L | last_job_end |
| M | processed |

---

## Scheduler

- **Production:** first batch at a random time between **6:45am–7:15am AEST**; **50–70 minute** random gap between batches; stops at **6pm AEST**; skips weekends
- **Testing:** starts immediately, no 6pm cutoff, no weekend skip
- Each batch runs for up to **60 minutes** — `shouldStop()` is checked between candidates, never mid-candidate
- The browser stays open all day and is only closed once at end of session

---

## Logging

Logs are written to `logs/rpa.log` and to the console. The log file is **reset after each successful login**, so it always reflects the current session only. Log files are excluded from version control.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Candidate not found this batch | Attempt counter incremented (`""` → `"1"` → `"2"` → `"ERROR"`) |
| Candidate reaches `"ERROR"` | Excluded from future runs; included in failure summary email |
| Breaking error inside `runBatch()` | Error email sent with full stack trace |
| Uncaught exception / rejection | Crash email sent; process exits (PM2 restarts) |
| Email credentials missing | Warning logged; email skipped silently |
| End of day session | Run report email sent listing each advert processed (date, reference number, title, candidate count) |

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
