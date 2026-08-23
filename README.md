# Labor Costs Automation (GitHub Actions + Playwright)

This replaces Apps Script's bot-blocked scraping with a real headless
browser running on GitHub's free infrastructure. It scrapes 6 of the 7
countries (Thailand has no source link — see below) and writes results
directly into your Google Sheet's "Labor Costs" tab.

## Why this exists

Apps Script's `UrlFetchApp` sends simple HTTP requests that
TradingEconomics blocks. Playwright launches an actual Chromium browser
that renders pages like a real visitor, which is far more likely to get
through. It's not a 100% guarantee — TradingEconomics could still detect
and block automated browsers — but it's a meaningfully stronger attempt
than anything possible inside Apps Script.

## One-time setup (about 20–30 minutes, all free)

These steps require **your own** Google and GitHub accounts — I can't
create these credentials on your behalf, only write the code that uses
them.

### 1. Create a Google Cloud service account

1. Go to https://console.cloud.google.com/
2. Create a new project (or use an existing one) — free, no billing
   required for this.
3. In the search bar, find **"Google Sheets API"** → click **Enable**.
4. Go to **IAM & Admin → Service Accounts → Create Service Account**.
   - Name it anything, e.g. `labor-costs-bot`.
   - Skip granting project-level roles (not needed).
   - Click **Done**.
5. Click on the new service account → **Keys** tab → **Add Key** →
   **Create new key** → **JSON**. This downloads a `.json` file —
   keep it private, treat it like a password.
6. Open that JSON file and copy the `client_email` value (looks like
   `labor-costs-bot@your-project.iam.gserviceaccount.com`).

### 2. Share your Google Sheet with the service account

1. Open your Google Sheet.
2. Click **Share**.
3. Paste in the `client_email` from step 1.6 above, give it **Editor**
   access, and send (uncheck "notify" if you don't want an email sent
   to that address).

### 3. Get your Spreadsheet ID

From your sheet's URL:
`https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit`

### 4. Create a GitHub repository

1. Go to https://github.com/new
2. Create a new **private** repository (private is fine and free).
3. Upload all the files from this folder (`scrape.js`, `package.json`,
   `.github/workflows/update-labor-costs.yml`, this `README.md`) —
   either via the GitHub web UI's "Upload files" button, or via git:
   ```
   git init
   git add .
   git commit -m "Initial labor costs automation"
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

### 5. Add your secrets to GitHub

In your new repo: **Settings → Secrets and variables → Actions → New
repository secret**. Add two secrets:

- `SPREADSHEET_ID` — the ID from step 3
- `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the **entire contents** of the
  JSON key file from step 1.5 (open it in a text editor, copy all of it)

### 6. Test it

Go to your repo's **Actions** tab → click **"Update Labor Costs"** on
the left → click **"Run workflow"** button → confirm. This runs it
immediately instead of waiting for the schedule. Check the log output
for ✅ or ❌ per country.

## What happens automatically after setup

- Runs on the 2nd of every month at 06:00 UTC, no further action needed.
- Writes each country's value into the current month's column,
  creating a new column if needed (matching your existing date-header
  format).
- Any country that fails gets `NEEDS MANUAL CHECK` written in its cell
  instead of silently leaving stale data — same safety behavior as the
  Apps Script version.
- Thailand always gets flagged for manual entry (no source exists).
- If anything fails, the GitHub Actions run shows as ❌ failed in your
  repo, and GitHub will email you (if you have notifications on) —
  check **Actions** tab periodically either way.

## If TradingEconomics still blocks this

If you start seeing `NEEDS MANUAL CHECK` across the board even with
this approach, it means TradingEconomics has started detecting headless
browsers specifically (a real possibility). At that point the remaining
options are: paid TradingEconomics API access, or accepting manual
monthly entry for this tab — there's no further free technical
workaround beyond this.
