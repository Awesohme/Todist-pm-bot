# Todoist PM Agent for Vercel

## What this does
- Exposes a Slack Events API endpoint at `/api/slack`
- Verifies Slack signatures using the raw request body
- Responds to Slack URL verification challenges
- Handles `app_mention` events
- Pulls Todoist tasks from `GET /api/v1/tasks`
- Replies in the same Slack thread with overdue / today / blocked / waiting / updates buckets

## Files
- `pages/api/slack.js` — Slack webhook handler
- `package.json` — minimal Next.js project

## Deploy to Vercel
1. Import this repo/folder into Vercel.
2. Add these environment variables:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `TODOIST_TOKEN`
3. Deploy.
4. Open `/api/slack` on the deployed domain. You should see:
   - `Vercel Slack handler is live`
5. In Slack App → Event Subscriptions, set Request URL to:
   - `https://your-project.vercel.app/api/slack`
6. Keep `app_mention` as the subscribed bot event.
7. Reinstall the Slack app if prompted.

## Notes
- This route disables Next.js body parsing because Slack signature verification must use the **raw request body**.
- If Slack URL verification fails, check that the endpoint is `/api/slack` and that Vercel env vars are set.
