# veritone-rpa-note-adding — Developer Guide

## How to Run

**Development (no build needed):**
```bash
npm run dev
```
Set `RUN_MODE=testing` in `.env` — starts immediately, no business-hours restriction, no weekend skip.

**Production:**
```bash
npm run build
pm2 start dist/src/scheduler.js --name s1hr-rpa
pm2 save
```

**After pushing changes to GCP:**
```bash
git pull && npm run build && pm2 restart s1hr-rpa
```

---

## Environment Variables

Copy `.env.template` to `.env`. Key variables:

| Variable | Notes |
|---|---|
| `RUN_MODE` | `testing` starts immediately; `production` enforces 6:45AM–6PM AEST |
| `LOOKBACK_DAYS` | Days back to search adverts in both phases (default: 30) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_SHEET_ID` | Same sheet as pre-screening RPA |
| `ADCOURIER_EMAIL` / `ADCOURIER_PASSWORD` | AD Courier login credentials |
| `EMAIL_USER` / `EMAIL_PASS` | Gmail App Password for notifications (optional — skipped silently if missing) |

Never commit `.env`.

---

## Project Structure

```
src/
├── main.ts                          Shared functions — launchAndLogin, runBatch, logoutAndClose
├── scheduler.ts                     Entry point — business-hours scheduler
├── automation/
│   ├── login.ts                     AD Courier login
│   ├── adverts.ts                   adref_no search, date filtering, hint matching, full iteration
│   └── responses.ts                 Candidate lookup and note insertion
├── orchestration/
│   └── candidate-processesor.ts    Phase 1 (adref_no) + Phase 2 (fallback) orchestration
├── services/
│   ├── email.ts                     Nodemailer Gmail wrapper
│   └── sheets.ts                    Google Sheets — reads Sheet1, marks rows, writes Summary tab
└── utils/
    ├── browser.ts                   Playwright browser lifecycle
    ├── logger.ts                    Winston logger + resetLogFile()
    └── shared/
        └── shared.ts                randomDelay(), BrowserSession, cleanupSession()
```

---

## Key Coding Practices

### Google Sheet layout
- **Sheet1** (`A:M`) — candidate form responses. Col D = `adref_no`, Col M = processed status
- **Summary tab** (`A:E`) — per-advert answered counts written at end of each day session
- Processed status values: `""` (not attempted), `"1"`, `"2"` (failed attempts), `"TRUE"` (done), `"ERROR"` (give up)
- Rows with `TRUE` or `ERROR` in col M are skipped by `getUnprocessedRows()`

### Summary tab counting
- Written by `mergeAnsweredSummary()` in `sheets.ts` at end of each day
- Counts **all rows** in Sheet1 per `adref_no` (col D), regardless of processed status — this is the true total of form respondents, not just candidates that got notes added
- Key format: `adref_no|datePosted` (datePosted = advert posting date scraped from Veritone, not form submission timestamp)
- Read by the pre-screening RPA to populate its email report

### Two-phase processing (`candidate-processesor.ts`)
- **Phase 1** — group candidates by `adref_no`, search Veritone directly by ref number
- **Phase 2** — fallback for blank `adref_no` or candidates not found in Phase 1; iterates all adverts within `LOOKBACK_DAYS`
- Phase 2 uses Veritone's internal `advertId` as the key in `advertResults` (not a real ref number) — these entries appear in the Summary tab but won't be matched by the pre-screening RPA

### Scheduler (`scheduler.ts`)
- First batch: random time between 6:45AM–7:15AM AEST
- Gap between batches: 50–70 minutes (randomised)
- End of day: 6PM AEST
- Each batch runs for up to 60 minutes — `shouldStop()` is checked between candidates, never mid-candidate
- Browser stays open all day; closed once at end of session
- To change the business hours window, update `BUSINESS_END_HOUR`, `FIRST_RUN_MIN_MINUTES`, and `FIRST_RUN_MAX_MINUTES` at the top of `scheduler.ts`

### Logging
- Log file is **reset after each successful login** — `logs/rpa.log` always reflects the current session only
- `resetLogFile()` is called in `launchAndLogin()` after login completes

### Error handling
- Candidates not found increment col M (`""` → `"1"` → `"2"` → `"ERROR"`) across runs
- `ERROR` candidates are excluded from future runs and included in the failure email
- Uncaught exceptions and unhandled rejections are both handled in `scheduler.ts` — crash email sent, process exits (pm2 restarts)

### Adding new note fields
- Note template is built in `responses.ts`
- New fields must come from Sheet1 columns — add the column mapping to the `CandidateRow` interface in `sheets.ts` and update `getUnprocessedRows()` to read it
- Update `findAndProcessCandidate()` in `responses.ts` to include the new field in the note body
