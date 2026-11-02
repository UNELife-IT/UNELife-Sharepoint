# UNE LIFE IT Library

A simple, public archive of guides and articles for UNE LIFE staff. No login is needed to read it.

Live site: https://sharepoint-guide-production.up.railway.app

## Uploading a guide (easiest)

1. Open the site and click **Upload a guide** (or go to `/upload.html`).
2. Choose your `.html` file. The title, summary and web address are filled in from the file where possible.
3. Pick a category and date, enter the upload password, and click **Upload guide**.

The guide appears in the library straight away. Uploading again with the same web address replaces it, and the **Uploaded guides** list on the same page lets you delete one.

Uploaded guides are stored on a Railway volume mounted at `/data`, so they survive redeploys. They are not in this repo.

## Adding a built-in article through the repo

Built-in articles live in `public/articles/` and can't be replaced or deleted from the upload page.

1. Copy `public/articles/_template.html` to a new file in `public/articles/`, e.g. `teams-meeting-tips.html`.
2. Add an entry to `public/articles/articles.json`:

   ```json
   {
     "title": "Teams Meeting Tips",
     "summary": "One or two sentences shown on the library page.",
     "category": "Teams",
     "date": "2026-11-02",
     "file": "teams-meeting-tips.html"
   }
   ```

3. Commit and push. Railway redeploys automatically within about a minute.

## Server settings

`server.js` is a small Node server with no dependencies. It reads these environment variables:

| Variable | Purpose |
| --- | --- |
| `UPLOAD_PASSWORD` | Password for uploading and deleting guides. Uploads are turned off when it is not set. |
| `DATA_DIR` | Where uploaded guides are stored (`/data` on Railway). |
| `PORT` | Port to listen on (Railway sets this). |

To change the upload password, update `UPLOAD_PASSWORD` in the Railway service's Variables tab.

Run locally with:

```bash
UPLOAD_PASSWORD=test node server.js
```
