# Athlete Data Hub

A personal training studio as a single web page: today's readiness, a session log, trends, sleep, running, and short notes on how each number is made.

The page is only a shell. It holds no health data, no PIN and no address of the data source. Everything private stays in a Google Sheet and is served by a Google Apps Script web app that checks a 4-digit PIN.

```
Fitbit -> Google Health API -> Apps Script (hourly pull) -> Google Sheet
                                        ^
                 this page  -- PIN -->  WebApi.gs (reads Daily, writes Log)
```

## Files

- `index.html` the whole site (no build step, no libraries)
- `apps-script/WebApi.gs` the PIN-gated API to add to the sheet's Apps Script project
- `apps-script/HealthCalories.gs` adds calories to the hourly Google Health pull
- `manifest.webmanifest`, `icon-*.png`, `icon.svg` the home-screen icon and app settings
- `.nojekyll` tells GitHub Pages to serve the files as they are

## Setup

1. **Script.** In the sheet's Apps Script project add `WebApi.gs`. Remove the old `doGet`, `doPost` and `parseBody_` from `Code.gs`. In `onOpen` add:
   ```js
   .addItem('Set website PIN', 'setWebPin')
   .addItem('Unlock website', 'unlockWeb')
   ```
2. **PIN.** Reload the sheet, choose Athlete Hub, then Set website PIN.
3. **Deploy.** Deploy, New deployment, Web app. Execute as: Me. Who has access: Anyone. Copy the address ending in `/exec`. Keep it out of this repository.
4. **Pages.** In the repository settings open Pages, choose Deploy from a branch, `main`, `/ (root)`.
5. **First visit.** Open the site, paste the script address once, type the PIN. The address is remembered on that device only; the PIN is asked every visit and after 10 minutes without use.

## How the lock works, and its limits

- The PIN is checked by the script, never by the page. Only a salted hash is stored, in Script Properties.
- 5 wrong PINs lock the site for 60 minutes. 15 wrong PINs in a row lock it until you choose Athlete Hub, then Unlock website, in the sheet.
- The script address is a second secret: without it nobody can even try a PIN. If it leaks, make a new deployment (the address changes) and archive the old one.
- A 4-digit PIN is a small secret. This protects a training log against casual and scripted guessing; it is not bank-grade. Someone who has the address can also lock you out by guessing wrong on purpose, which you clear from the sheet.
- The site is a training aid, not medical advice.
