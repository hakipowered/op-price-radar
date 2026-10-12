# TCG Price Radar

A daily-updated price radar for trading cards and sealed product, built to help when buying on Courtyard.

**Live site:** https://hakipowered.github.io/op-price-radar/

Games: One Piece (English), Pokémon (English), Pokémon (Japanese). Switch between them at the top of the site.

## What it does

- **Market**: every product TCGplayer lists for the game, priced or not, with market price, lowest listing, 1/7/30/90-day changes and a 30-day sparkline. Search understands TCGplayer names and Courtyard titles alike: paste `#OP01-120 Shanks (Parallel)` or `#199/165 Charizard ex` and it finds the card.
- **Movers**: what is heating up (rising over both 7 and 30 days), the biggest risers and the biggest fallers.
- **Sets**: a heat map of every set over 1, 7 or 30 days, using an index of each set's 20 most valuable singles.
- **Courtyard Check**: paste a Courtyard listing title and its price to get a verdict, the offer to make and the profit if you resell. A grade in the title (e.g. PSA 10) switches the check to graded.
- **Watchlist**: star cards, set target prices, and get them in the daily Telegram digest.
- **Card detail**: price history chart, TCGplayer listing prices and a buy guide (offer at / pay at most / resell near).

The footer shows coverage for the selected game: sets loaded, products, how many have a price, and days of history.

## How it updates

`.github/workflows/update.yml` runs every day at 21:17 UTC, after tcgcsv.com refreshes its TCGplayer data. It:

1. downloads the stored price history (a file per game kept in the **price-history** release),
2. fetches every set for each game (`scripts/update.py`) and adds today's prices to the history,
3. uploads the updated history and publishes the site to GitHub Pages,
4. sends the Telegram digest if alerts are set up.

The history keeps every day for 35 days, then one point a week up to six months. It lives in the release rather than the code so the repository stays small. Don't delete the **price-history** release, or the charts start again from scratch.

You can run it by hand any time: **Actions → Daily price update → Run workflow**.

## Telegram alerts (optional)

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token it gives you.
2. Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat` → `id` number.
3. In this repository: **Settings → Secrets and variables → Actions → New repository secret**. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

Watchlist targets for alerts live in `watchlist.json`. Use **Copy alert list** on the site's Watchlist tab and paste it into that file. The file is public.

## Limits

- Prices are TCGplayer's: raw cards and sealed product. Graded prices are not included.
- Japanese One Piece is not on TCGplayer and needs a separate price source (not added yet).
- Prices refresh once a day.
- The app never reads Courtyard's website; Courtyard's terms forbid automated access. Courtyard Check works from what you type or paste in.

## Offline test

Run in a scratch copy of the repo (test files must never be committed):

```
for d in 12 9 6 3 1 0; do
  python tests/make_fixtures.py --day $d
  python scripts/update.py --fixtures tests/fixtures --no-telegram --date $(date -u -d "-$d day" +%F)
done
```

Data: TCGplayer market prices via [tcgcsv.com](https://tcgcsv.com). Not affiliated with Courtyard or TCGplayer. Not financial advice.
