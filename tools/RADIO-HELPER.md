# Radio helper (for team radio transcripts)

Undercut writes team radio out as text with a speech model that runs in your browser. To do that
the page has to read each audio clip — and F1's server doesn't allow websites to do that. The
radio helper is a tiny program that fetches a clip for the site. It runs free on Cloudflare.

It only fetches F1 team radio `.mp3` files, and only answers your Undercut site.

## Set it up (about 5 minutes, free, no card)

1. Make a free account at **dash.cloudflare.com/sign-up**.
2. In the dashboard: **Workers & Pages → Create → Create Worker**. Name it `radio-helper` and press **Deploy**.
3. Press **Edit code**. Delete what's there and paste everything from
   [`radio-helper.js`](radio-helper.js). If your site address isn't
   `https://kris-zhang-122507.github.io`, change the `SITE` line to match.
4. Press **Deploy**. Copy the worker's address — it looks like
   `https://radio-helper.yourname.workers.dev`.
5. On Undercut: Team radio → tick **Transcribe** → paste the address into the radio helper box → **Save**.

Clips are then transcribed automatically. The free plan allows 100,000 requests a day — a race
weekend uses a few hundred at most.

## If it says the helper couldn't get the clip

F1's server sometimes refuses requests from cloud services. If you see "F1 answered 403", the
helper is set up correctly but F1 is blocking Cloudflare — there's nothing more to fix on your side.
