Apps Script that keeps Workdesk's meetings up to date. Written in TypeScript, bundled to `gs/dist/` and
deployed by `.github/workflows/gs-deploy.yml`.

A 30-minute trigger calls `checkMeetings`. On Mon-Fri, 08:30-17:00 it:

1. Skips if `nextCheck` is still in the future.
2. Reads meetings from now to the end of today. All-day and declined ones don't count.
3. Sends them to `POST /api/events` if they changed. A meeting finishing isn't a change.
4. If a meeting is running, sets `nextCheck` to its end. Otherwise leaves `nextCheck` as it is.

The logic is in `gs/src/check.ts`, and `gs/test/check.test.ts` replays a full day.

Part of the Workdesk project: it shares the root `package.json`, `tsconfig.json` and ESLint config.

```
npm run gs:test
npm run gs:build
```

## First-time setup

1. Turn on the Apps Script API at https://script.google.com/home/usersettings.
2. Create the script: `npx clasp login`, then `npx clasp create-script --type standalone --title workdesk-gs --rootDir gs/dist` from the repo root.
   Note the script ID, then delete the `.clasp.json` it writes if you don't need it locally.
3. Add GitHub Actions secrets:
   - `GAS_SCRIPT_ID`: the script ID.
   - `CLASPRC_JSON`: the contents of `~/.clasprc.json`. It grants access to your Google account, so treat it as a password.
4. Create a Workdesk API key with scope `events`.
5. Push to `main` to deploy, then in the Apps Script editor:
   - Project Settings -> Script properties: add `WORKDESK_URL` and `WORKDESK_KEY`.
   - Run `installTrigger` once and approve the permissions.

## Releasing

Bump `gs/VERSION` and push to `main`. Pushes that touch `gs/` without a new version only run the tests.
