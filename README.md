# OP Price Radar

A daily-updated price radar for One Piece Card Game cards and sealed product, built to help when buying on Courtyard.

**Live site:** https://hakipowered.github.io/op-price-radar/

## What it does

- **Market**: every One Piece card and sealed product listed on TCGplayer, with market price, lowest listing, 1/7/30/90-day changes and a 30-day sparkline. Search by name or card number, filter by set, rarity, chase cards and minimum price.
- **Movers**: what is heating up (rising over both 7 and 30 days), the biggest risers and the biggest fallers.
- **Sets**: a heat map of every set, using an index of its 20 most valuable singles.
- **Courtyard Check**: type in a Courtyard listing and get a verdict, the offer to make and the profit if you resell.
- **Watchlist**: star cards, set target prices, and get them in the daily Telegram digest.
- **Card detail**: price history chart, TCGplayer listing prices and a buy guide (offer at / pay at most / resell near).

## How it updates

`.github/workflows/update.yml` runs every day at 21:17 UTC (00:17 in Bahrain), after tcgcsv.com refreshes its TCGplayer data. It:

1. fetches all One Piece prices (`scripts/update.py`),
2. saves a compact daily snapshot in `data/snapshots/` (this is the price history),
3. builds the site's data files and publishes the site to GitHub Pages,
4. sends the Telegram digest if alerts are set up.

On the very first run it also pulls a spread of past days from tcgcsv's daily archives, so changes and charts work straight away.

You can run it by hand any time: **Actions → Daily price update → Run workflow**.

## Telegram alerts (optional)

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token it gives you.
2. Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat` → `id` number.
3. In this repository: **Settings → Secrets and variables → Actions → New repository secret**. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

Watchlist targets for alerts live in `watchlist.json`. Use **Copy alert list** on the site's Watchlist tab and paste it into that file.

## Limits

- Raw English cards and sealed product only. Graded (PSA/CGC) and Japanese prices are not included yet.
- Prices refresh once a day.
- The app never reads Courtyard's website; Courtyard's terms forbid automated access. Courtyard Check works from what you type in.

## Offline test

```
python tests/make_fixtures.py   # writes fake data into tests/fixtures and data/snapshots
python scripts/update.py --fixtures tests/fixtures --no-telegram
```
Run this in a scratch copy of the repo: the fake snapshots must never be committed.

Data: TCGplayer market prices via [tcgcsv.com](https://tcgcsv.com). Not affiliated with Courtyard or TCGplayer. Not financial advice.
