#!/usr/bin/env python3
"""TCG Price Radar - daily updater.

Fetches TCGplayer prices (published daily by tcgcsv.com) for each game, keeps a rolling
price history per game, writes the data files the website reads, and sends an optional
Telegram digest.

Usage:
  python scripts/update.py                     # normal daily run
  python scripts/update.py --fixtures DIR      # offline test run from saved JSON
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import html
import io
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://tcgcsv.com/tcgplayer"
HIST_DIR = ROOT / "history"                 # stored between runs as a GitHub release asset
LEGACY_SNAPS = ROOT / "data" / "snapshots"  # old per-day files, migrated once into history
WATCHLIST = ROOT / "watchlist.json"
USER_AGENT = "tcg-price-radar/2.0 (+https://github.com/{repo})"

DAILY_DAYS = 35      # keep every day for this long ...
KEEP_DAYS = 190      # ... then one point per week up to this age
SPARK_DAYS = 30
SPARK_MIN = 1.0      # sparklines only for items worth at least this much

GAMES = [
    {"id": "op", "name": "One Piece", "lang": "EN", "cats": [68]},
    {"id": "pkmn", "name": "Pokémon", "lang": "EN", "cats": [3]},
    {"id": "pkmnjp", "name": "Pokémon", "lang": "JP", "cats": [85]},
]

SINGLE, SEALED = "single", "sealed"
FIELDS = ["k", "id", "n", "s", "no", "r", "t", "m", "l", "p", "c1", "c7", "c30", "c90", "h"]

SUBTYPE_CODES = {
    "Normal": "N", "Foil": "F", "Holofoil": "H", "Reverse Holofoil": "R",
    "1st Edition": "1", "1st Edition Normal": "1N", "1st Edition Holofoil": "1H",
    "Unlimited": "U", "Unlimited Holofoil": "UH",
}
SUBTYPE_PRIMARY = ["Normal", "Holofoil", "Foil", "Unlimited", "Unlimited Holofoil",
                   "1st Edition", "1st Edition Normal", "1st Edition Holofoil", "Reverse Holofoil"]


# ---------------------------------------------------------------- sources
class Source:
    """Reads tcgcsv JSON over HTTP, or from a fixtures folder for offline tests."""

    def __init__(self, fixtures: Path | None, repo: str):
        self.fixtures = fixtures
        self.session = None
        if fixtures is None:
            import requests

            self.session = requests.Session()
            self.session.headers["User-Agent"] = USER_AGENT.format(repo=repo)

    def get(self, path: str):
        if self.fixtures is not None:
            return json.loads((self.fixtures / (path.replace("/", "_") + ".json")).read_text())
        for attempt in range(4):
            try:
                r = self.session.get(f"{BASE}/{path}", timeout=60)
                r.raise_for_status()
                time.sleep(0.25)  # polite pacing, as tcgcsv's own sample code does
                return r.json()
            except Exception as exc:  # noqa: BLE001
                if attempt == 3:
                    raise
                print(f"  retry {path}: {exc}", file=sys.stderr)
                time.sleep(3 * (attempt + 1))
        return None


# ---------------------------------------------------------------- helpers
def ext(product: dict, name: str) -> str:
    for item in product.get("extendedData") or []:
        if item.get("name") == name:
            return str(item.get("value") or "").strip()
    return ""


def r2(x):
    return None if x is None else round(float(x), 2)


def pct(new, old):
    if new is None or old in (None, 0):
        return None
    return round((new - old) / old * 100, 1)


def pick_price(m, low, mid):
    """Market price first; fall back to the lowest listing unless it is an obvious junk listing."""
    if m is not None:
        return m
    if low is not None and (mid is None or low <= mid * 3):
        return low
    return mid


def sub_code(name: str) -> str:
    if name in SUBTYPE_CODES:
        return SUBTYPE_CODES[name]
    return "".join(w[0] for w in re.findall(r"[A-Za-z0-9]+", name)).upper() or "X"


def classify(product: dict) -> str:
    # Cards carry a number or a rarity (DON!! cards have a rarity but no number).
    return SINGLE if ext(product, "Number") or ext(product, "Rarity") else SEALED


# ---------------------------------------------------------------- history
class History:
    """Rolling price history for one game: one column per kept day, one row per item."""

    def __init__(self, path: Path):
        self.path = path
        self.dates: list[str] = []
        self.rows: dict[str, list] = {}
        if path.exists():
            with gzip.open(path, "rt", newline="") as f:
                rd = csv.reader(f)
                header = next(rd, None)
                if header:
                    self.dates = header[1:]
                    for row in rd:
                        self.rows[row[0]] = [float(v) if v else None for v in row[1:]] + \
                            [None] * (len(self.dates) - len(row) + 1)

    def set_day(self, day: str, prices: dict[str, float]) -> None:
        if day in self.dates:
            idx = self.dates.index(day)
        else:
            self.dates.append(day)
            order = sorted(range(len(self.dates)), key=lambda i: self.dates[i])
            self.dates = [self.dates[i] for i in order]
            for k in self.rows:
                self.rows[k] = [(self.rows[k] + [None])[i] for i in order]
            idx = self.dates.index(day)
        width = len(self.dates)
        for k, v in prices.items():
            row = self.rows.setdefault(k, [None] * width)
            if len(row) < width:
                row.extend([None] * (width - len(row)))
            row[idx] = v

    def prune(self, today: dt.date) -> None:
        keep, weeks = [], set()
        for d in sorted(self.dates, reverse=True):
            age = (today - dt.date.fromisoformat(d)).days
            if age > KEEP_DAYS:
                continue
            if age <= DAILY_DAYS:
                keep.append(d)
                continue
            wk = dt.date.fromisoformat(d).isocalendar()[:2]
            if wk not in weeks:
                weeks.add(wk)
                keep.append(d)
        keep = sorted(keep)
        idx = [self.dates.index(d) for d in keep]
        rows = {}
        for k, row in self.rows.items():
            new = [row[i] if i < len(row) else None for i in idx]
            if any(v is not None for v in new):
                rows[k] = new
        self.dates, self.rows = keep, rows

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["key"] + self.dates)
        for k in sorted(self.rows):
            w.writerow([k] + ["" if v is None else f"{v:g}" for v in self.rows[k]])
        with gzip.open(self.path, "wt", newline="") as f:
            f.write(buf.getvalue())

    def value_at(self, key: str, target: dt.date, max_gap: int):
        row = self.rows.get(key)
        if not row:
            return None
        for i in range(len(self.dates) - 1, -1, -1):
            day = dt.date.fromisoformat(self.dates[i])
            if day > target:
                continue
            if (target - day).days > max_gap:
                return None
            if row[i] is not None:
                return row[i]
        return None

    def recent(self, key: str, today: dt.date, days: int) -> list:
        row = self.rows.get(key) or []
        out = []
        for i, d in enumerate(self.dates):
            if (today - dt.date.fromisoformat(d)).days < days:
                out.append(row[i] if i < len(row) else None)
        return out

    def seed_from_legacy(self) -> int:
        """One-time migration from the old data/snapshots/*.csv.gz files."""
        n = 0
        for p in sorted(LEGACY_SNAPS.glob("*.csv.gz")):
            try:
                day = dt.date.fromisoformat(p.name[:10]).isoformat()
            except ValueError:
                continue
            prices = {}
            with gzip.open(p, "rt", newline="") as f:
                for row in csv.DictReader(f):
                    v = row.get("m") or row.get("l")
                    if v:
                        prices[row["key"]] = float(v)
            self.set_day(day, prices)
            n += 1
        return n


# ---------------------------------------------------------------- build one game
def build_game(src: Source, game: dict, out_root: Path, today: dt.date, repo: str) -> dict:
    gid_game = game["id"]
    label = f"{game['name']} ({game['lang']})"
    print(f"\n== {label}")
    sets: dict[int, dict] = {}
    items: dict[str, dict] = {}
    extra: dict[int, dict[str, list]] = defaultdict(dict)
    cov = {"groups": 0, "fetched": 0, "failed": [], "products": 0, "variants": 0, "priced": 0}

    for cat in game["cats"]:
        groups = src.get(f"{cat}/groups")["results"]
        cov["groups"] += len(groups)
        for g in groups:
            gid = g["groupId"]
            try:
                products = src.get(f"{cat}/{gid}/products")["results"]
                prices = src.get(f"{cat}/{gid}/prices")["results"]
            except Exception as exc:  # noqa: BLE001
                print(f"  set {gid} skipped: {exc}", file=sys.stderr)
                cov["failed"].append(g.get("name") or str(gid))
                continue
            cov["fetched"] += 1
            cov["products"] += len(products)
            sets[gid] = {"id": gid, "n": g.get("name", ""), "a": g.get("abbreviation") or "",
                         "d": (g.get("publishedOn") or "")[:10]}
            by_pid = defaultdict(list)
            for pr in prices:
                by_pid[pr["productId"]].append(pr)
            for prod in products:
                pid = prod["productId"]
                rows = by_pid.get(pid) or [None]
                subs = [(r or {}).get("subTypeName") or "Normal" for r in rows]
                primary = next((s for s in SUBTYPE_PRIMARY if s in subs), subs[0])
                used: set[str] = set()
                for r, sub in zip(rows, subs):
                    code = sub_code(sub)
                    while code in used:
                        code += "x"
                    used.add(code)
                    key = f"{pid}:{code}"
                    m = r2((r or {}).get("marketPrice"))
                    low = r2((r or {}).get("lowPrice"))
                    mid = r2((r or {}).get("midPrice"))
                    hi = r2((r or {}).get("highPrice"))
                    name = prod.get("name", "")
                    if len(rows) > 1 and sub != primary:
                        name += f" ({sub})"
                    items[key] = {
                        "k": key, "id": pid, "n": name, "s": gid,
                        "no": ext(prod, "Number"), "r": ext(prod, "Rarity"), "t": classify(prod),
                        "m": m, "l": low, "p": pick_price(m, low, mid),
                    }
                    extra[gid][key] = [mid, hi, ext(prod, "Color"), ext(prod, "CardType")]
    cov["variants"] = len(items)
    cov["priced"] = sum(1 for i in items.values() if i["p"] is not None)
    print(f"  {cov['fetched']}/{cov['groups']} sets, {cov['products']} products, "
          f"{cov['variants']} variants, {cov['priced']} priced")
    if cov["failed"]:
        print(f"  failed sets: {', '.join(cov['failed'][:20])}")
    if not cov["priced"]:
        raise RuntimeError(f"No prices fetched for {label}")

    # history
    hist = History(HIST_DIR / f"history-{gid_game}.csv.gz")
    if gid_game == "op" and not hist.dates and LEGACY_SNAPS.exists():
        print(f"  migrated {hist.seed_from_legacy()} old daily snapshots")
    hist.set_day(today.isoformat(), {k: i["p"] for k, i in items.items() if i["p"] is not None})
    hist.prune(today)
    hist.save()

    for key, it in items.items():
        cur = it["p"]
        it["c1"] = pct(cur, hist.value_at(key, today - dt.timedelta(days=1), 3))
        it["c7"] = pct(cur, hist.value_at(key, today - dt.timedelta(days=7), 4))
        it["c30"] = pct(cur, hist.value_at(key, today - dt.timedelta(days=30), 7))
        it["c90"] = pct(cur, hist.value_at(key, today - dt.timedelta(days=90), 14))
        spark = hist.recent(key, today, SPARK_DAYS) if (cur or 0) >= SPARK_MIN else []
        it["h"] = spark if sum(v is not None for v in spark) >= 2 else []

    # set indexes: basket of the set's 20 most valuable singles today
    by_set = defaultdict(list)
    for it in items.values():
        by_set[it["s"]].append(it)
    for gid, st in sets.items():
        in_set = by_set.get(gid, [])
        singles = sorted((i for i in in_set if i["t"] == SINGLE and i["p"]), key=lambda i: i["p"], reverse=True)
        basket = singles[:20]
        st["cnt"] = len(in_set)
        st["pr"] = sum(1 for i in in_set if i["p"] is not None)
        st["v"] = round(sum(i["p"] for i in basket), 2) if basket else 0
        for label_, days, gap in (("c1", 1, 3), ("c7", 7, 4), ("c30", 30, 7)):
            pairs = [(i["p"], hist.value_at(i["k"], today - dt.timedelta(days=days), gap)) for i in basket]
            pairs = [(a, b) for a, b in pairs if b is not None]
            st[label_] = pct(sum(a for a, _ in pairs), sum(b for _, b in pairs)) \
                if basket and len(pairs) >= max(3, 0.6 * len(basket)) else None
        st["top"] = basket[0]["k"] if basket else None
        boxes = [i for i in in_set if i["t"] == SEALED and i["p"] and re.search(r"booster box", i["n"], re.I)]
        st["box"] = max(boxes, key=lambda i: i["p"])["k"] if boxes else None

    # write
    out = out_root / gid_game
    (out / "sets").mkdir(parents=True, exist_ok=True)
    meta = {
        "game": gid_game, "name": game["name"], "lang": game["lang"],
        "updated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "dataDate": today.isoformat(), "historyDays": len(hist.dates),
        "firstDate": hist.dates[0] if hist.dates else today.isoformat(),
        "items": cov["variants"], "priced": cov["priced"], "products": cov["products"],
        "sets": cov["fetched"], "groups": cov["groups"], "failed": cov["failed"], "repo": repo,
    }
    payload = {"meta": meta, "fields": FIELDS, "sets": list(sets.values()),
               "items": [[it.get(f) for f in FIELDS] for it in items.values()]}
    (out / "cards.json").write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    for gid in sets:
        rows = {i["k"]: hist.rows[i["k"]] for i in by_set.get(gid, []) if i["k"] in hist.rows}
        (out / "sets" / f"{gid}.json").write_text(json.dumps(
            {"dates": hist.dates, "s": rows, "x": extra.get(gid, {})},
            separators=(",", ":"), ensure_ascii=False))
    size = (out / "cards.json").stat().st_size
    print(f"  wrote {gid_game}/cards.json ({size / 1e6:.1f} MB), history {len(hist.dates)} days")
    return {"meta": meta, "items": list(items.values()), "sets": sets}


# ---------------------------------------------------------------- telegram
def digest(results: dict, site_url: str) -> str:
    parts = [f"<b>TCG Price Radar · {next(iter(results.values()))['meta']['dataDate']}</b>"]
    for gid, res in results.items():
        items = res["items"]
        per = "c7" if any(i.get("c7") is not None for i in items) else "c1"
        liquid = [i for i in items if (i["p"] or 0) >= 5 and i.get(per) is not None]
        up = [i for i in sorted(liquid, key=lambda i: i[per], reverse=True)[:3] if i[per] > 0]
        down = [i for i in sorted(liquid, key=lambda i: i[per])[:3] if i[per] < 0]
        if not up and not down:
            continue
        m = res["meta"]
        parts += ["", f"<b>{html.escape(m['name'])} {m['lang']}</b> ({'7 days' if per == 'c7' else '1 day'})"]
        for i in up + down:
            code = i["no"] or res["sets"].get(i["s"], {}).get("a", "")
            parts.append(f"• {html.escape(i['n'])} <i>{html.escape(code)}</i> ${i['p']:.2f} ({i[per]:+.1f}%)")
    hits = watch_hits(results)
    if hits:
        parts += ["", "<b>Your watchlist</b>"] + hits
    parts += ["", f'<a href="{site_url}">Open the radar</a>']
    return "\n".join(parts)[:4000]


def watch_hits(results: dict) -> list[str]:
    if not WATCHLIST.exists():
        return []
    try:
        wl = json.loads(WATCHLIST.read_text()).get("items", [])
    except Exception:  # noqa: BLE001
        return []
    by_key = {f"{g}|{i['k']}": i for g, res in results.items() for i in res["items"]}
    out = []
    for w in wl:
        key = str(w.get("key") or "")
        if "|" not in key:
            key = f"op|{key}"
        it = by_key.get(key)
        if not it or it["p"] is None:
            continue
        cur, target, name = it["p"], w.get("target"), html.escape(it["n"])
        if target and cur <= float(target):
            out.append(f"• {name}: ${cur:.2f}, at or below your ${float(target):.2f} target")
        elif it.get("c1") is not None and abs(it["c1"]) >= 15:
            out.append(f"• {name}: ${cur:.2f}, moved {it['c1']:+.1f}% since yesterday")
    return out


def send_telegram(text: str) -> None:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        print("Telegram not configured - skipping digest.")
        return
    import requests

    r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                      json={"chat_id": chat, "text": text, "parse_mode": "HTML",
                            "disable_web_page_preview": True}, timeout=30)
    print(f"Telegram digest sent ({r.status_code}).")


# ---------------------------------------------------------------- entry
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", type=Path, help="read tcgcsv JSON from this folder instead of the web")
    ap.add_argument("--out", type=Path, default=ROOT / "site" / "data")
    ap.add_argument("--date", help="override the data date (YYYY-MM-DD)")
    ap.add_argument("--games", help="comma-separated game ids to build (default: all)")
    ap.add_argument("--no-telegram", action="store_true")
    args = ap.parse_args()

    repo = os.environ.get("GITHUB_REPOSITORY", "hakipowered/op-price-radar")
    owner, name = repo.split("/", 1)
    site_url = os.environ.get("SITE_URL", f"https://{owner}.github.io/{name}/")
    today = dt.date.fromisoformat(args.date) if args.date else dt.datetime.now(dt.timezone.utc).date()
    wanted = set(args.games.split(",")) if args.games else None

    src = Source(args.fixtures, repo)
    results, index = {}, []
    for game in GAMES:
        if wanted and game["id"] not in wanted:
            continue
        try:
            res = build_game(src, game, args.out, today, repo)
        except Exception as exc:  # noqa: BLE001
            print(f"!! {game['name']} ({game['lang']}) failed: {exc}", file=sys.stderr)
            continue
        results[game["id"]] = res
        index.append(res["meta"])
    if not results:
        raise SystemExit("No game built - aborting so the site keeps its last data.")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "games.json").write_text(json.dumps({"games": index}, indent=1, ensure_ascii=False))

    text = digest(results, site_url)
    print("\n" + text)
    if not args.no_telegram and args.fixtures is None:
        send_telegram(text)


if __name__ == "__main__":
    main()
