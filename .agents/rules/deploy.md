# Deploy / update the live web (VPS)

The production site runs on a VPS managed by **PM2**. Follow this exactly when the user says "push lên web" / "update web" / "deploy".

## Facts (verified 2026-09-21)
- **VPS host:** `EliteTaxToolVibeCode` (IP seen historically `168.144.169.160`). Access = user SSHs in themselves and pastes output; the agent does NOT have SSH access.
- **GitHub remote:** `https://github.com/tannn5788/successwatool.git`, branch **`main`**.
- **⚠️ Live folder PM2 actually runs = `/var/www/successwa`** (NO "tool" suffix). Confirm anytime with:
  `pm2 info successwa | grep -Ei "exec cwd|script path"` → must show `/var/www/successwa/server.js`.
- There is ALSO a stale folder `/var/www/successwatool` on the VPS — **do NOT deploy there, PM2 does not use it.** (We wasted a round updating it by mistake.)
- PM2 app name = **`successwa`**, cluster mode, 2 instances, config `ecosystem.config.js`.
- VPS Node = **v20.20.2** (googleapis wants >=22 → harmless `EBADENGINE` warnings, ignore).
- `.env` and `uploads/` are **gitignored** → `git reset --hard` never touches them (safe). `.env` lives inside the live folder already.

## Step 1 — Local (Windows, d:\Successwa): commit + push
NEVER commit `.env`. Exclude screenshots / Office docs. Then push to origin/main.
```powershell
git add -A ':!*.png' ':!*.docx' ':!*.pptx'
git commit -m "<message>"
git push origin main
```
(PowerShell shows git's stderr as a red "error" — that's benign. Verify with `git status -sb` → `## main...origin/main` and `git log -1 --oneline origin/main`.)

## Step 2 — On the VPS: update the LIVE folder (TH1, the confirmed working path)
The live folder `/var/www/successwa` IS a git repo wired to origin. User runs:
```bash
cd /var/www/successwa
git fetch origin
git reset --hard origin/main
npm install --omit=dev
node db/init.js          # idempotent; applies schema.sql (new columns etc.)
pm2 reload ecosystem.config.js
```
Then hard-refresh the browser (Ctrl+Shift+R) — bump `?v=` on changed client JS/CSS so cache busts.

## Gotchas / lessons
- **If new features look "y xì như cũ" after deploy → check `pm2 info successwa` cwd first.** Almost certainly the update went to the wrong folder (`successwatool`) while PM2 runs `/var/www/successwa`.
- **`node db/init.js` printing bare `Init failed:` with no detail** → usually `.env` in that folder is missing/empty (`DATABASE_URL` undefined). Debug: `node db/init.js 2>&1 | tail -20` and `node -e "require('dotenv').config(); console.log((process.env.DATABASE_URL||'').length)"`.
- Branding in code is already **"Syraxx"** (titles, nav label, logo alt). Remaining "Successwa" strings are internal only (email domain `@successwa.com`, localStorage key `successwa.auth`, comments) — not user-facing.
- Login URL has no `.html` (e.g. `http://<host>/login`).
