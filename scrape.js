// UNIFIED SHEET AUTOMATION — Material Costs + Labor Costs
// -----------------------------------------------------------------------
// One script, one schedule, one repo — covers both tabs of the same
// Google Sheet document. Uses the right tool per source:
//   - FRED, Yahoo Finance, World Bank -> plain HTTP requests (fast,
//     these are real APIs and were never blocked)
//   - LME (Aluminium, Tin) and TradingEconomics (Labor Costs) -> a real
//     headless browser via Playwright (these sources block simple
//     HTTP requests, confirmed during earlier Apps Script attempts)
//
// SETUP: see README.md. Same service account / secrets pattern as
// before, plus one new secret: FRED_API_KEY.

const { chromium } = require('playwright');
const { google } = require('googleapis');
const XLSX = require('xlsx');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || 'PASTE_YOUR_SPREADSHEET_ID_HERE';
const FRED_API_KEY = process.env.FRED_API_KEY || 'PASTE_YOUR_FRED_KEY_HERE';

const MATERIAL_SHEET = 'Material Costs';
const LABOR_SHEET = 'Labor Costs';
const START_COLUMN = 5; // column E = Jan-25 on both tabs

// -----------------------------------------------------------------------
// Config — Material Costs
// -----------------------------------------------------------------------

const MATERIAL_ROWS = {
  STEEL_REBAR: 2,
  SP500: 3,
  CORRUGATED_BOX: 4,
  PLASTICS_FILM: 5,
  RESIN: 6,
  PCB: 7,
  GOLD: 8,
  SILVER: 9,
  BRASS: 10,
  ALUMINUM: 11,
  COPPER: 12,
  TIN: 13,
};

const FRED_SERIES = {
  CORRUGATED_BOX: 'PCU32221132221102',
  PLASTICS_FILM: 'PCU32611232611212',
  RESIN: 'PCU325211325211',
  PCB: 'PCU3344123344120',
  STEEL_REBAR: 'WPU101704',
  BRASS: 'PCU429930429930213',
};

const WORLD_BANK_URL =
  'https://thedocs.worldbank.org/en/doc/18675f1d1639c7a34d463f59263ba0a2-0050012025/related/CMO-Historical-Data-Monthly.xlsx';

const LME_URLS = {
  ALUMINUM: 'https://www.lme.com/metals/non-ferrous/lme-aluminium',
  TIN: 'https://www.lme.com/metals/non-ferrous/lme-tin',
};

// -----------------------------------------------------------------------
// Config — Labor Costs
// -----------------------------------------------------------------------

const LABOR_ROWS = {
  MEXICO: 2,
  TAIWAN: 3,
  CHINA: 4,
  THAILAND: 5,
  USA: 6,
  VIETNAM: 7,
  PHILIPPINES: 8,
};

const LABOR_SOURCES = {
  MEXICO: { url: 'https://tradingeconomics.com/mexico/labour-costs', unit: 'points' },
  CHINA: { url: 'https://tradingeconomics.com/china/labour-costs', unit: 'points' },
  USA: { url: 'https://tradingeconomics.com/united-states/labour-costs', unit: 'points' },
  VIETNAM: { url: 'https://tradingeconomics.com/vietnam/wages', unit: 'VND Thousand/Month' },
  PHILIPPINES: { url: 'https://tradingeconomics.com/philippines/minimum-wages', unit: 'PHP/Day' },
  TAIWAN: { url: 'https://tradingeconomics.com/taiwan/labour-costs', unit: 'points' },
};

// -----------------------------------------------------------------------
// Plain HTTP fetchers (FRED, Yahoo, World Bank) — no browser needed
// -----------------------------------------------------------------------

async function fetchFredPrice(seriesId) {
  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error_message) throw new Error(`FRED error for ${seriesId}: ${json.error_message}`);
  if (!json.observations || json.observations.length === 0) {
    throw new Error(`FRED returned no data for ${seriesId}`);
  }
  const value = parseFloat(json.observations[0].value);
  if (isNaN(value)) throw new Error(`FRED value not numeric for ${seriesId}`);
  return value;
}

async function fetchYahooLatestClose(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1mo&range=6mo`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error(`Yahoo Finance returned HTML for ${ticker} (blocked)`);
  const json = JSON.parse(text);
  if (json.chart.error) throw new Error(`Yahoo Finance API error for ${ticker}: ${JSON.stringify(json.chart.error)}`);
  const closes = json.chart.result[0].indicators.quote[0].close;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] !== null) return closes[i];
  }
  throw new Error(`Yahoo Finance returned no valid close values for ${ticker}`);
}

async function fetchCopperPricePerMT() {
  const perLb = await fetchYahooLatestClose('HG=F');
  return perLb * 2204.62;
}

async function fetchSP500ContainersPackaging() {
  return fetchYahooLatestClose('^SP500-151030');
}

async function fetchWorldBankMetalPrice(metalName) {
  const res = await fetch(WORLD_BANK_URL);
  const buffer = await res.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });

  const sheetName = workbook.SheetNames.find((n) => n.toLowerCase().includes('monthly prices'));
  if (!sheetName) throw new Error('Could not find Monthly Prices tab in World Bank file');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  const headerRowIndex = rows.findIndex((r) => r.some((cell) => String(cell).trim() === 'Gold'));
  if (headerRowIndex === -1) throw new Error('Could not find header row in World Bank file');

  const headerRow = rows[headerRowIndex];
  const colIndex = headerRow.findIndex((h) => String(h).toLowerCase().includes(metalName.toLowerCase()));
  if (colIndex === -1) throw new Error(`Could not find ${metalName} column in World Bank data`);

  // Data starts 2 rows after header (header row, then units row, then data).
  // Walk backward from the end to find the most recent non-blank value.
  for (let i = rows.length - 1; i >= headerRowIndex + 2; i--) {
    const value = rows[i][colIndex];
    if (value !== '' && value !== null && !isNaN(value)) {
      return value;
    }
  }
  throw new Error(`No numeric World Bank value found for ${metalName}`);
}

// -----------------------------------------------------------------------
// Browser-based fetchers (LME, TradingEconomics) — need real rendering
// -----------------------------------------------------------------------

async function scrapeLmePrice(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const bodyText = await page.textContent('body');
  const match =
    bodyText.match(/LME\s+\w+\s*\n*\s*([\d,]+\.\d+)\s*-?\d/i) ||
    bodyText.match(/(\d{1,3}(?:,\d{3})*\.\d+)\s*-?\d+\.\d+%\s*\n*\s*3-month Closing Price/i);
  if (!match) throw new Error(`LME price pattern not found for ${url} (blocked or layout changed)`);
  const value = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(value)) throw new Error(`LME value parsed as NaN for ${url}`);
  return value;
}

async function scrapeTradingEconomicsValue(page, url, unit) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const bodyText = await page.textContent('body');
  const escapedUnit = unit.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  // Handles both "increased/decreased TO X" and "remained unchanged AT X"
  const pattern = new RegExp('(?:to|at)\\s+([\\d,\\.]+)\\s+' + escapedUnit, 'i');
  const match = bodyText.match(pattern);
  if (!match) throw new Error(`Pattern not found for ${url} (unit: ${unit}). Page layout may have changed.`);
  const value = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(value)) throw new Error(`Value parsed as NaN for ${url}`);
  return value;
}

// -----------------------------------------------------------------------
// Google Sheets helpers (shared across both tabs)
// -----------------------------------------------------------------------

async function getSheetsClient() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? undefined : './service-account.json';
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

async function getOrCreateCurrentMonthColumn(sheets, sheetName) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1:ZZ1`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const headerRow = res.data.values ? res.data.values[0] : [];
  const lastCol = headerRow.length;

  for (let col = START_COLUMN; col <= lastCol; col++) {
    const cellValue = headerRow[col - 1];
    if (typeof cellValue === 'number') {
      const cellDate = new Date(Math.round((cellValue - 25569) * 86400 * 1000));
      if (cellDate.getUTCFullYear() === currentYear && cellDate.getUTCMonth() === currentMonth) {
        return col;
      }
    }
  }

  const newCol = lastCol + 1;
  const newColLetter = colNumberToLetter(newCol);
  const newDate = new Date(Date.UTC(currentYear, currentMonth, 1));
  const serial = Math.round(newDate.getTime() / 86400000) + 25569;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!${newColLetter}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[serial]] },
  });

  return newCol;
}

async function writeCell(sheets, sheetName, row, col, value) {
  const colLetter = colNumberToLetter(col);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!${colLetter}${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function runMaterialCosts(sheets, page, errors) {
  console.log('\n=== Material Costs ===');
  const col = await getOrCreateCurrentMonthColumn(sheets, MATERIAL_SHEET);
  console.log(`Writing to column ${colNumberToLetter(col)}`);

  // Plain HTTP sources first — fast, no browser needed.
  const httpTasks = [
    { key: 'GOLD', row: MATERIAL_ROWS.GOLD, fn: () => fetchWorldBankMetalPrice('Gold') },
    { key: 'SILVER', row: MATERIAL_ROWS.SILVER, fn: () => fetchWorldBankMetalPrice('Silver') },
    { key: 'COPPER', row: MATERIAL_ROWS.COPPER, fn: fetchCopperPricePerMT },
    { key: 'SP500', row: MATERIAL_ROWS.SP500, fn: fetchSP500ContainersPackaging },
    { key: 'CORRUGATED_BOX', row: MATERIAL_ROWS.CORRUGATED_BOX, fn: () => fetchFredPrice(FRED_SERIES.CORRUGATED_BOX) },
    { key: 'PLASTICS_FILM', row: MATERIAL_ROWS.PLASTICS_FILM, fn: () => fetchFredPrice(FRED_SERIES.PLASTICS_FILM) },
    { key: 'RESIN', row: MATERIAL_ROWS.RESIN, fn: () => fetchFredPrice(FRED_SERIES.RESIN) },
    { key: 'PCB', row: MATERIAL_ROWS.PCB, fn: () => fetchFredPrice(FRED_SERIES.PCB) },
    { key: 'STEEL_REBAR', row: MATERIAL_ROWS.STEEL_REBAR, fn: () => fetchFredPrice(FRED_SERIES.STEEL_REBAR) },
    { key: 'BRASS', row: MATERIAL_ROWS.BRASS, fn: () => fetchFredPrice(FRED_SERIES.BRASS) },
  ];

  for (const task of httpTasks) {
    try {
      const value = await task.fn();
      await writeCell(sheets, MATERIAL_SHEET, task.row, col, value);
      console.log(`✅ ${task.key}: ${value}`);
    } catch (e) {
      console.error(`❌ ${task.key}: ${e.message}`);
      await writeCell(sheets, MATERIAL_SHEET, task.row, col, 'NEEDS MANUAL CHECK');
      errors.push(`Material Costs / ${task.key}: ${e.message}`);
    }
  }

  // Browser-based sources — LME (Aluminium, Tin).
  const browserTasks = [
    { key: 'ALUMINUM', row: MATERIAL_ROWS.ALUMINUM, fn: () => scrapeLmePrice(page, LME_URLS.ALUMINUM) },
    { key: 'TIN', row: MATERIAL_ROWS.TIN, fn: () => scrapeLmePrice(page, LME_URLS.TIN) },
  ];

  for (const task of browserTasks) {
    try {
      const value = await task.fn();
      await writeCell(sheets, MATERIAL_SHEET, task.row, col, value);
      console.log(`✅ ${task.key}: ${value}`);
    } catch (e) {
      console.error(`❌ ${task.key}: ${e.message}`);
      await writeCell(sheets, MATERIAL_SHEET, task.row, col, 'NEEDS MANUAL CHECK');
      errors.push(`Material Costs / ${task.key}: ${e.message}`);
    }
  }
}

async function runLaborCosts(sheets, page, errors) {
  console.log('\n=== Labor Costs ===');
  const col = await getOrCreateCurrentMonthColumn(sheets, LABOR_SHEET);
  console.log(`Writing to column ${colNumberToLetter(col)}`);

  const tasks = [
    { key: 'MEXICO', row: LABOR_ROWS.MEXICO, source: LABOR_SOURCES.MEXICO },
    { key: 'CHINA', row: LABOR_ROWS.CHINA, source: LABOR_SOURCES.CHINA },
    { key: 'USA', row: LABOR_ROWS.USA, source: LABOR_SOURCES.USA },
    { key: 'VIETNAM', row: LABOR_ROWS.VIETNAM, source: LABOR_SOURCES.VIETNAM },
    { key: 'PHILIPPINES', row: LABOR_ROWS.PHILIPPINES, source: LABOR_SOURCES.PHILIPPINES },
    { key: 'TAIWAN', row: LABOR_ROWS.TAIWAN, source: LABOR_SOURCES.TAIWAN },
  ];

  for (const task of tasks) {
    try {
      const value = await scrapeTradingEconomicsValue(page, task.source.url, task.source.unit);
      await writeCell(sheets, LABOR_SHEET, task.row, col, value);
      console.log(`✅ ${task.key}: ${value}`);
    } catch (e) {
      console.error(`❌ ${task.key}: ${e.message}`);
      await writeCell(sheets, LABOR_SHEET, task.row, col, 'NEEDS MANUAL CHECK');
      errors.push(`Labor Costs / ${task.key}: ${e.message}`);
    }
  }

  // Thailand has no source — always flagged.
  await writeCell(sheets, LABOR_SHEET, LABOR_ROWS.THAILAND, col, 'NEEDS MANUAL ENTRY — no source link available');
}

async function main() {
  console.log('Starting unified sheet automation run...');

  const sheets = await getSheetsClient();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const errors = [];

  try {
    await runMaterialCosts(sheets, page, errors);
    await runLaborCosts(sheets, page, errors);
  } finally {
    await browser.close();
  }

  if (errors.length > 0) {
    console.log('\n--- Summary: some sources failed ---');
    errors.forEach((e) => console.log(e));
    process.exitCode = 1;
  } else {
    console.log('\nAll sources updated successfully across both tabs.');
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exitCode = 1;
});
