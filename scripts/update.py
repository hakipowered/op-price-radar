#!/usr/bin/env python3
"""OP Price Radar - daily updater.

Fetches One Piece Card Game prices (TCGplayer data published by tcgcsv.com),
stores one compact snapshot per day, builds the data files the website reads,
and sends an optional Telegram digest.

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
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATEGORY = 68  # One Piece Card Game on TCGplayer
BASE = "https://tcgcsv.com/tcgplayer"
ARCHIVE = "https://tcgcsv.com/archive/tcgplayer/prices-{date}.ppmd.7z"
SNAP_DIR = ROOT / "data" / "snapshots"
WATCHLIST = ROOT / "watchlist.json"
HISTORY_DAYS = 180
SPARK_POINTS = 30
BACKFILL_OFFSETS = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180]
USER_AGENT = "op-price-radar/1.0 (+https://github.com/{repo})"

SINGLE = "single"
SEALED = "sealed"


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


def snap_path(day: dt.date) -> Path:
    return SNAP_DIR / f"{day.isoformat()}.csv.gz"


def write_snapshot(day: dt.date, prices: dict[str, dict]) -> None:
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["key", "m", "l", "mid", "hi"])
    for key in sorted(prices):
        p = prices[key]
        w.writerow([key, p.get("m") or "", p.get("l") or "", p.get("mid") or "", p.get("hi") or ""])
    with gzip.open(snap_path(day), "wt", newline="") as f:
        f.write(buf.getvalue())


def read_snapshot(path: Path) -> dict[str, float]:
    out: dict[str, float] = {}
    with gzip.open(path, "rt", newline="") as f:
        for row in csv.DictReader(f):
            v = row.get("m") or row.get("l")
            if v:
                out[row["key"]] = float(v)
    return out


def price_rows_to_map(results: list[dict]) -> dict[str, dict]:
    out = {}
    for p in results:
        sub = (p.get("subTypeName") or "Normal")[:1].upper()
        key = f"{p['productId']}:{sub}"
        out[key] = {
            "m": r2(p.get("marketPrice")),
            "l": r2(p.get("lowPrice")),
            "mid": r2(p.get("midPrice")),
            "hi": r2(p.get("highPrice")),
        }
    return out


# ---------------------------------------------------------------- backfill
def backfill(today: dt.date, repo: str) -> None:
    """First run only: pull a spread of past days from tcgcsv's daily archives,
    so price changes and charts work from day one. Best effort."""
    existing = list(SNAP_DIR.glob("*.csv.gz")) if SNAP_DIR.exists() else []
    if len(existing) >= 5:
        return
    import requests

    sess = requests.Session()
    sess.headers["User-Agent"] = USER_AGENT.format(repo=repo)
    started = time.time()
    log: list[str] = []

    def note(msg: str) -> None:
        print(msg)
        log.append(msg)

    for off in BACKFILL_OFFSETS:
        if time.time() - started > 25 * 60:
            print("  backfill: time budget used, history will fill in daily from here")
            break
        day = today - dt.timedelta(days=off)
        if snap_path(day).exists():
            continue
        tmp = Path(tempfile.mkdtemp(prefix="opr-"))
        try:
            arc = tmp / "a.7z"
            with sess.get(ARCHIVE.format(date=day.isoformat()), stream=True, timeout=300) as r:
                if r.status_code != 200:
                    note(f"backfill {day}: HTTP {r.status_code} from {r.url}")
                    continue
                with open(arc, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            out = tmp / "x"
            extracted = False
            try:
                import py7zr

                with py7zr.SevenZipFile(arc, "r") as z:
                    targets = [n for n in z.getnames() if re.fullmatch(rf"[^/]+/{CATEGORY}/\d+/prices", n)]
                with py7zr.SevenZipFile(arc, "r") as z:
                    z.extract(path=out, targets=targets)
                extracted = True
            except Exception as exc:  # noqa: BLE001
                note(f"backfill {day}: py7zr failed ({exc!r}), trying 7z")
            if not extracted and shutil.which("7z"):
                subprocess.run(["7z", "x", f"-o{out}", str(arc), f"*/{CATEGORY}/*/prices", "-r", "-y"],
                               check=False, capture_output=True)
            prices: dict[str, dict] = {}
            for f in out.glob(f"*/{CATEGORY}/*/prices"):
                try:
                    prices.update(price_rows_to_map(json.loads(f.read_text()).get("results", [])))
                except Exception:  # noqa: BLE001
                    pass
            files = list(out.rglob("prices"))
            note(f"backfill {day}: {arc.stat().st_size} bytes, {len(files)} price files, "
                 f"{len(prices)} One Piece prices, sample path {files[0].relative_to(out) if files else '-'}")
            if prices:
                write_snapshot(day, prices)
        except Exception as exc:  # noqa: BLE001
            note(f"backfill {day}: skipped ({exc!r})")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / "backfill.log").write_text("\n".join(log) + "\n")


# ---------------------------------------------------------------- main build
def classify(product: dict) -> str:
    # Cards carry a number or rarity (DON!! cards have a rarity but no number).
    return SINGLE if ext(product, "Number") or ext(product, "Rarity") else SEALED


def load_history(today: dt.date) -> tuple[list[str], dict[str, dict[str, float]]]:
    cutoff = today - dt.timedelta(days=HISTORY_DAYS)
    snaps = {}
    for p in sorted(SNAP_DIR.glob("*.csv.gz")):
        try:
            day = dt.date.fromisoformat(p.name[:10])
        except ValueError:
            continue
        if cutoff <= day <= today:
            snaps[day.isoformat()] = read_snapshot(p)
    return sorted(snaps), snaps


def value_at(dates: list[str], snaps: dict, key: str, target: dt.date, max_gap: int):
    """Market value on the latest snapshot at or before `target`, within `max_gap` days."""
    for d in reversed(dates):
        day = dt.date.fromisoformat(d)
        if day > target:
            continue
        if (target - day).days > max_gap:
            return None
        return snaps[d].get(key)
    return None


def build(src: Source, out_dir: Path, today: dt.date, repo: str) -> dict:
    print(f"Fetching One Piece sets for {today} ...")
    groups = src.get(f"{CATEGORY}/groups")["results"]
    items: dict[str, dict] = {}
    sets: dict[int, dict] = {}
    for g in groups:
        gid = g["groupId"]
        try:
            products = src.get(f"{CATEGORY}/{gid}/products")["results"]
            prices = src.get(f"{CATEGORY}/{gid}/prices")["results"]
        except Exception as exc:  # noqa: BLE001
            print(f"  set {gid} skipped: {exc}", file=sys.stderr)
            continue
        sets[gid] = {
            "id": gid,
            "n": g.get("name", ""),
            "a": g.get("abbreviation") or "",
            "d": (g.get("publishedOn") or "")[:10],
        }
        pmap = {p["productId"]: p for p in products}
        subs_per_product: dict[int, int] = {}
        for pr in prices:
            subs_per_product[pr["productId"]] = subs_per_product.get(pr["productId"], 0) + 1
        for key, px in price_rows_to_map(prices).items():
            pid = int(key.split(":")[0])
            prod = pmap.get(pid)
            if not prod:
                continue
            if px["m"] is None and px["l"] is None:
                continue
            name = prod.get("name", "")
            sub = key.split(":")[1]
            if subs_per_product.get(pid, 1) > 1 and sub == "F":
                name += " (Foil)"
            items[key] = {
                "k": key,
                "id": pid,
                "n": name,
                "s": gid,
                "no": ext(prod, "Number"),
                "r": ext(prod, "Rarity"),
                "c": ext(prod, "Color"),
                "ct": ext(prod, "CardType"),
                "t": classify(prod),
                "u": prod.get("url", ""),
                **px,
            }
    print(f"  {len(items)} priced items across {len(sets)} sets")
    if not items:
        raise SystemExit("No prices fetched - aborting so the site keeps yesterday's data.")

    write_snapshot(today, {k: {f: v[f] for f in ("m", "l", "mid", "hi")} for k, v in items.items()})
    dates, snaps = load_history(today)

    # per-item changes and sparklines
    for key, it in items.items():
        cur = it["m"] if it["m"] is not None else it["l"]
        it["c1"] = pct(cur, value_at(dates, snaps, key, today - dt.timedelta(days=1), 3))
        it["c7"] = pct(cur, value_at(dates, snaps, key, today - dt.timedelta(days=7), 4))
        it["c30"] = pct(cur, value_at(dates, snaps, key, today - dt.timedelta(days=30), 7))
        it["c90"] = pct(cur, value_at(dates, snaps, key, today - dt.timedelta(days=90), 14))
        spark = [snaps[d].get(key) for d in dates[-SPARK_POINTS:]]
        it["h"] = spark if sum(v is not None for v in spark) >= 2 else []

    # set indexes: fixed basket of the set's 20 most valuable singles today
    for gid, st in sets.items():
        singles = sorted((i for i in items.values() if i["s"] == gid and i["t"] == SINGLE and i["m"]),
                         key=lambda i: i["m"], reverse=True)
        basket = singles[:20]
        st["cnt"] = sum(1 for i in items.values() if i["s"] == gid)
        st["v"] = round(sum(i["m"] for i in basket), 2) if basket else 0
        for label, days, gap in (("c7", 7, 4), ("c30", 30, 7)):
            then = [value_at(dates, snaps, i["k"], today - dt.timedelta(days=days), gap) for i in basket]
            if basket and all(v is not None for v in then):
                st[label] = pct(st["v"], sum(then))
            else:
                st[label] = None
        st["top"] = basket[0]["k"] if basket else None
        sealed = [i for i in items.values() if i["s"] == gid and i["t"] == SEALED and i["m"]]
        box = next((i for i in sealed if re.search(r"booster box", i["n"], re.I)), None)
        st["box"] = box["k"] if box else None

    # write site data
    out_dir.mkdir(parents=True, exist_ok=True)
    hist_dir = out_dir / "history"
    hist_dir.mkdir(exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    meta = {
        "updated": now,
        "dataDate": today.isoformat(),
        "historyDays": len(dates),
        "firstDate": dates[0] if dates else today.isoformat(),
        "items": len(items),
        "sets": len(sets),
        "repo": repo,
        "source": "TCGplayer market prices via tcgcsv.com",
    }
    cards = {"meta": meta, "sets": list(sets.values()), "items": list(items.values())}
    (out_dir / "cards.json").write_text(json.dumps(cards, separators=(",", ":")))
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    for gid in sets:
        keys = [k for k, i in items.items() if i["s"] == gid]
        payload = {"dates": dates, "s": {k: [snaps[d].get(k) for d in dates] for k in keys}}
        (hist_dir / f"{gid}.json").write_text(json.dumps(payload, separators=(",", ":")))
    print(f"  wrote site data ({len(dates)} days of history)")
    return cards


# ---------------------------------------------------------------- telegram
def digest(cards: dict, site_url: str) -> str:
    items = cards["items"]
    sets = {s["id"]: s for s in cards["sets"]}
    liquid = [i for i in items if (i["m"] or 0) >= 5 and i.get("c7") is not None]
    up = sorted(liquid, key=lambda i: i["c7"], reverse=True)[:5]
    down = sorted(liquid, key=lambda i: i["c7"])[:5]

    def line(i):
        code = i["no"] or sets.get(i["s"], {}).get("a", "")
        return f"• {html.escape(i['n'])} <i>{html.escape(code)}</i> ${i['m']:.2f} ({i['c7']:+.1f}%)"

    parts = [f"<b>OP Price Radar · {cards['meta']['dataDate']}</b>"]
    if up and up[0]["c7"] > 0:
        parts += ["", "<b>Rising this week</b>"] + [line(i) for i in up if i["c7"] > 0]
    if down and down[0]["c7"] < 0:
        parts += ["", "<b>Falling this week</b>"] + [line(i) for i in down if i["c7"] < 0]

    hits = watch_hits(cards)
    if hits:
        parts += ["", "<b>Your watchlist</b>"] + hits
    parts += ["", f'<a href="{site_url}">Open the radar</a>']
    return "\n".join(parts)


def watch_hits(cards: dict) -> list[str]:
    if not WATCHLIST.exists():
        return []
    try:
        wl = json.loads(WATCHLIST.read_text()).get("items", [])
    except Exception:  # noqa: BLE001
        return []
    by_key = {i["k"]: i for i in cards["items"]}
    out = []
    for w in wl:
        it = by_key.get(str(w.get("key")))
        if not it:
            continue
        cur = it["m"] if it["m"] is not None else it["l"]
        target = w.get("target")
        name = html.escape(it["n"])
        if target and cur is not None and cur <= float(target):
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
    ap.add_argument("--date", help="override the snapshot date (YYYY-MM-DD)")
    ap.add_argument("--no-telegram", action="store_true")
    args = ap.parse_args()

    repo = os.environ.get("GITHUB_REPOSITORY", "hakipowered/op-price-radar")
    owner, name = repo.split("/", 1)
    site_url = os.environ.get("SITE_URL", f"https://{owner}.github.io/{name}/")
    today = dt.date.fromisoformat(args.date) if args.date else dt.datetime.now(dt.timezone.utc).date()

    # Note: tcgcsv's history archives refuse automated downloads (HTTP 403), so
    # backfill() is not called. History builds from the daily snapshots instead.
    cards = build(Source(args.fixtures, repo), args.out, today, repo)
    text = digest(cards, site_url)
    print(text)
    if not args.no_telegram and args.fixtures is None:
        send_telegram(text)


if __name__ == "__main__":
    main()
