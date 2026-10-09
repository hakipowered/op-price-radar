"""Builds a small fake tcgcsv dataset plus 40 days of fake snapshots, for offline testing.

Run:  python tests/make_fixtures.py && python scripts/update.py --fixtures tests/fixtures --no-telegram
The numbers are synthetic test data, not real prices.
"""
import csv
import datetime as dt
import gzip
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
SNAP = ROOT / "data" / "snapshots"
random.seed(7)

SETS = [
    (90001, "Test Set Alpha", "TS01", "2026-08-28"),
    (90002, "Test Set Beta", "TS02", "2026-05-30"),
    (90003, "Test Set Gamma", "TS03", "2026-02-21"),
]
RARITIES = ["C"] * 6 + ["UC"] * 4 + ["R"] * 3 + ["SR", "SR", "SEC", "L"]
NAMES = ["Test Captain", "Test Navigator", "Test Swordsman", "Test Cook", "Test Doctor", "Test Sniper",
         "Test Shipwright", "Test Musician", "Test Archaeologist", "Test Helmsman"]


def ext(**kw):
    return [{"name": k, "displayName": k, "value": v} for k, v in kw.items()]


def main():
    FIX.mkdir(parents=True, exist_ok=True)
    groups = {"totalItems": len(SETS), "success": True, "errors": [],
              "results": [{"groupId": g, "name": n, "abbreviation": a, "isSupplemental": False,
                           "publishedOn": d + "T00:00:00", "modifiedOn": d + "T00:00:00", "categoryId": 68}
                          for g, n, a, d in SETS]}
    (FIX / "68_groups.json").write_text(json.dumps(groups))
    base_prices = {}
    pid = 800000
    for g, n, a, _ in SETS:
        products, prices = [], []
        for i in range(1, 41):
            pid += 1
            r = random.choice(RARITIES)
            name = f"{random.choice(NAMES)}"
            if i % 13 == 0:
                name += " (Parallel)"
            products.append({"productId": pid, "name": name, "cleanName": name, "imageUrl": "",
                             "categoryId": 68, "groupId": g, "url": f"https://www.tcgplayer.com/product/{pid}",
                             "extendedData": ext(Rarity=r, Number=f"{a}-{i:03d}", Color="Red", CardType="Character")})
            base = {"C": .2, "UC": .4, "R": 1.5, "SR": 6, "SEC": 45, "L": 3}[r] * (8 if "Parallel" in name else 1)
            m = round(base * random.uniform(.6, 1.8), 2)
            base_prices[f"{pid}:{'F' if r in ('SR', 'SEC', 'L') else 'N'}"] = m
            prices.append({"productId": pid, "lowPrice": round(m * .88, 2), "midPrice": round(m * 1.1, 2),
                           "highPrice": round(m * 2, 2), "marketPrice": m, "directLowPrice": None,
                           "subTypeName": "Foil" if r in ("SR", "SEC", "L") else "Normal"})
        for label, m in (("Booster Box", 110.0), ("Booster Pack", 4.2)):
            pid += 1
            products.append({"productId": pid, "name": f"{n} {label}", "cleanName": f"{n} {label}", "imageUrl": "",
                             "categoryId": 68, "groupId": g, "url": f"https://www.tcgplayer.com/product/{pid}",
                             "extendedData": []})
            m = round(m * random.uniform(.8, 1.4), 2)
            base_prices[f"{pid}:N"] = m
            prices.append({"productId": pid, "lowPrice": m, "midPrice": m, "highPrice": m * 1.3, "marketPrice": m,
                           "directLowPrice": None, "subTypeName": "Normal"})
        (FIX / f"68_{g}_products.json").write_text(json.dumps({"totalItems": len(products), "success": True, "errors": [], "results": products}))
        (FIX / f"68_{g}_prices.json").write_text(json.dumps({"success": True, "errors": [], "results": prices}))

    # fake history: a random walk ending at today's prices
    SNAP.mkdir(parents=True, exist_ok=True)
    today = dt.datetime.now(dt.timezone.utc).date()
    for back in range(40, 0, -1):
        day = today - dt.timedelta(days=back)
        with gzip.open(SNAP / f"{day}.csv.gz", "wt", newline="") as f:
            w = csv.writer(f)
            w.writerow(["key", "m", "l", "mid", "hi"])
            for k, m in base_prices.items():
                drift = 1 + (random.uniform(-.012, .012) * back) + random.uniform(-.03, .03)
                w.writerow([k, round(m / max(drift, .3), 2), "", "", ""])
    print(f"fixtures in {FIX}, {len(base_prices)} items, 40 days of fake snapshots in {SNAP}")


if __name__ == "__main__":
    main()
