# Radio helper (team radio transcripts)

F1's server doesn't let websites read its radio clips, so Undercut can play them but can't turn
them into text by itself. The radio helper is a tiny program on Cloudflare's free plan that
fetches each clip and transcribes it with Whisper (OpenAI's speech model, run by Cloudflare).

- **Free:** Cloudflare's free plan includes about 200 minutes of transcription a day — a whole race weekend of radio is a small fraction of that.
- **Locked down:** it only works with F1 team radio clips, and only answers your Undercut site.
- **Once:** set it up once; your browser remembers its address.

## Set it up (about 5 minutes, no card needed)

1. Make a free account at **dash.cloudflare.com/sign-up** and verify your email.
2. In the dashboard: **Compute (Workers) → Workers & Pages → Create → Create Worker** (start from "Hello World").
   Name it `radio-helper` and press **Deploy**.
3. Press **Edit code**. Delete everything in the editor, paste everything from
   [`radio-helper.js`](radio-helper.js), and press **Deploy**.
   (If your site is somewhere else, change the `SITE` line first — the full address is fine.)
4. Go back to the worker → **Settings → Bindings → Add → Workers AI**. Set the variable name to
   **`AI`** and save. *(This is what lets it transcribe.)*
5. Copy the worker's address from its overview page — it looks like
   `https://radio-helper.YOURNAME.workers.dev`.
6. On Undercut: **Team radio → tick Transcribe → paste the address → Save.**

New clips are then written out as text, each line marked **DRIVER** or **TEAM** (a best guess:
the driver's mic has engine noise behind it, the pit wall doesn't).

## Checking it works

Open `https://radio-helper.YOURNAME.workers.dev/transcribe?url=https://livetiming.formula1.com/static/2026/2026-10-11_Singapore_Grand_Prix/2026-10-11_Race/TeamRadio/ALB_23_20261011_195602.mp3`
in your browser. You should see some JSON with the words.

- `F1 answered 403` — F1 is refusing Cloudflare's servers. The helper is set up right, but this
  route can't work; there's nothing more to fix on your side.
- `Workers AI isn't connected` — redo step 4 (the name must be exactly `AI`).
- `{"text":"","segments":[]}` — the clip arrived but no words came back. Open the same link with
  `/debug` instead of `/transcribe` (`https://radio-helper.YOURNAME.workers.dev/debug?url=...`).
  It shows how big the clip was, its first bytes, and what each speech model answered.
