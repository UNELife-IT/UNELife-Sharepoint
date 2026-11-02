# UNE LIFE IT Library

A simple, public archive of guides and articles for UNE LIFE staff. No login is needed to read it.

Live site: https://sharepoint-guide-production.up.railway.app

## Adding an article

1. Copy `articles/_template.html` to a new file in `articles/`, e.g. `articles/teams-meeting-tips.html`.
   (Any self-contained HTML page works too.)
2. Edit the title and content.
3. Add an entry to `articles/articles.json`:

   ```json
   {
     "title": "Teams Meeting Tips",
     "summary": "One or two sentences shown on the library page.",
     "category": "Teams",
     "date": "2026-11-02",
     "file": "teams-meeting-tips.html"
   }
   ```

   Separate entries with a comma. `category` creates a filter button automatically; `date` is `YYYY-MM-DD` and the newest articles are listed first.
4. Commit and push. Railway redeploys the site automatically within about a minute.

To remove an article, delete its file and its entry in `articles.json`.
