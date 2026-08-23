// LABOR COSTS AUTOMATION — Playwright + Google Sheets API
// -----------------------------------------------------------------------
// Runs in GitHub Actions (real browser, not blocked like Apps Script's
// simple fetch). Visits each source page, extracts the current labor
// cost figure, and writes it into the correct month column of the
// "Labor Costs" tab in your Google Sheet.
//
// SOURCES:
//  - Mexico, China, USA, Vietnam, Philippines, Taiwan -> TradingEconomics
//  - Thailand -> no source link exists; always flagged for manual entry
//
// SETUP REQUIRED (see README.md for full steps):
//  1. npm install
//  2. Create a Google Cloud service account with Sheets API access,
//     download its JSON key, save as service-account.json (or set as
//     GOOGLE_SERVICE_ACCOUNT_JSON secret in GitHub Actions).
//  3. Share your Google Sheet with the service account's email
//     (found in the JSON key as "client_email") — give it Editor access.
//  4. Set SPREADSHEET_ID below (or as a GitHub Actions secret/env var).

const { chromium } = require('playwright');
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || 'PASTE_YOUR_SPREADSHEET_ID_HERE';
const SHEET_NAME = 'Labor Costs';
const START_COLUMN = 5; // column E = Jan-25, matching your existing layout

// Row numbers — confirmed against your actual sheet layout
const ROWS = {
  MEXICO: 2,
  TAIWAN: 3,
  CHINA: 4,
  THAILAND: 5,
  USA: 6,
  VIETNAM: 7,
  PHILIPPINES: 8,
};

const SOURCES = {
  MEXICO: { url: 'https://tradingeconomics.com/mexico/labour-costs', unit: 'points' },
  CHINA: { url: 'https://tradingeconomics.com/china/labour-costs', unit: 'points' },
  USA: { url: 'https://tradingeconomics.com/united-states/labour-costs', unit: 'points' },
  VIETNAM: { url: 'https://tradingeconomics.com/vietnam/wages', unit: 'VND Thousand/Month' },
  PHILIPPINES: { url: 'https://tradingeconomics.com/philippines/minimum-wages', unit: 'PHP/Day' },
  TAIWAN: { url: 'https://tradingeconomics.com/taiwan/labour-costs', unit: 'points' },
};

// -----------------------------------------------------------------------
// Scraping logic
// -----------------------------------------------------------------------

async function scrapeTradingEconomics(page, url, unit) {
  // 'domcontentloaded' instead of 'networkidle': financial pages often
  // have live tickers/ads/trackers that never let network activity fully
  // stop, causing 'networkidle' to time out even on healthy pages.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // Give the page a few seconds for client-side rendering to settle.
  await page.waitForTimeout(3000);

  const bodyText = await page.textContent('body');

  // Pattern: "... increased to X points in MONTH from Y points in MONTH of YEAR"
  // Handles both wordings TradingEconomics uses:
  // "increased/decreased TO X points" (value changed)
  // "remained unchanged AT X points" (value stayed the same)
  const escapedUnit = unit.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pattern = new RegExp('(?:to|at)\\s+([\\d,\\.]+)\\s+' + escapedUnit, 'i');
  const match = bodyText.match(pattern);

  if (!match) {
    throw new Error(`Pattern not found for ${url} (unit: ${unit}). Page layout may have changed.`);
  }

  const value = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(value)) {
    throw new Error(`Parsed value is NaN for ${url}`);
  }
  return value;
}

// -----------------------------------------------------------------------
// Google Sheets helpers
// -----------------------------------------------------------------------

async function getSheetsClient() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? undefined
    : './service-account.json';
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : undefined;

  const auth = new google.auth.GoogleAuth({
    keyFile,
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

function colNumberToLetter(col) {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

async function getOrCreateCurrentMonthColumn(sheets) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-indexed

  const headerRange = `${SHEET_NAME}!A1:ZZ1`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: headerRange,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const headerRow = res.data.values ? res.data.values[0] : [];
  let lastCol = headerRow.length;

  for (let col = START_COLUMN; col <= lastCol; col++) {
    const cellValue = headerRow[col - 1];
    if (typeof cellValue === 'number') {
      // Sheets stores dates as serial numbers; convert to compare.
      const cellDate = new Date(Math.round((cellValue - 25569) * 86400 * 1000));
      if (cellDate.getUTCFullYear() === currentYear && cellDate.getUTCMonth() === currentMonth) {
        return col;
      }
    }
  }

  // No existing column for this month — create one right after the last column.
  const newCol = lastCol + 1;
  const newColLetter = colNumberToLetter(newCol);
  const newDate = new Date(Date.UTC(currentYear, currentMonth, 1));
  const serial = Math.round(newDate.getTime() / 86400000) + 25569;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${newColLetter}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[serial]] },
  });

  return newCol;
}

async function writeCell(sheets, row, col, value) {
  const colLetter = colNumberToLetter(col);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${colLetter}${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  console.log('Starting Labor Costs automation run...');

  const sheets = await getSheetsClient();
  const col = await getOrCreateCurrentMonthColumn(sheets);
  console.log(`Writing to column ${colNumberToLetter(col)}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const errors = [];

  const tasks = [
    { key: 'MEXICO', row: ROWS.MEXICO, fn: () => scrapeTradingEconomics(page, SOURCES.MEXICO.url, SOURCES.MEXICO.unit) },
    { key: 'CHINA', row: ROWS.CHINA, fn: () => scrapeTradingEconomics(page, SOURCES.CHINA.url, SOURCES.CHINA.unit) },
    { key: 'USA', row: ROWS.USA, fn: () => scrapeTradingEconomics(page, SOURCES.USA.url, SOURCES.USA.unit) },
    { key: 'VIETNAM', row: ROWS.VIETNAM, fn: () => scrapeTradingEconomics(page, SOURCES.VIETNAM.url, SOURCES.VIETNAM.unit) },
    { key: 'PHILIPPINES', row: ROWS.PHILIPPINES, fn: () => scrapeTradingEconomics(page, SOURCES.PHILIPPINES.url, SOURCES.PHILIPPINES.unit) },
    { key: 'TAIWAN', row: ROWS.TAIWAN, fn: () => scrapeTradingEconomics(page, SOURCES.TAIWAN.url, SOURCES.TAIWAN.unit) },
  ];

  for (const task of tasks) {
    try {
      const value = await task.fn();
      await writeCell(sheets, task.row, col, value);
      console.log(`✅ ${task.key}: ${value}`);
    } catch (e) {
      console.error(`❌ ${task.key}: ${e.message}`);
      await writeCell(sheets, task.row, col, 'NEEDS MANUAL CHECK');
      errors.push(`${task.key}: ${e.message}`);
    }
  }

  // Thailand has no source — always flag it.
  await writeCell(sheets, ROWS.THAILAND, col, 'NEEDS MANUAL ENTRY — no source link available');

  await browser.close();

  if (errors.length > 0) {
    console.log('\n--- Summary: some sources failed ---');
    errors.forEach((e) => console.log(e));
    // Exit with non-zero code so GitHub Actions flags the run as failed,
    // making it visible in your repo's Actions tab / email notifications.
    process.exitCode = 1;
  } else {
    console.log('\nAll sources updated successfully.');
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exitCode = 1;
});
