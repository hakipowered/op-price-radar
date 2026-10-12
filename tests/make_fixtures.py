"""Writes a small fake tcgcsv dataset for offline testing. The numbers are synthetic, not real prices.

  python tests/make_fixtures.py --day 0     # prices for "today"
  python tests/make_fixtures.py --day 9     # prices 9 days earlier (a deterministic random walk)

Typical test (in a scratch copy of the repo, never committed):
  for d in 12 9 6 3 1 0; do
    python tests/make_fixtures.py --day $d
    python scripts/update.py --fixtures tests/fixtures --no-telegram --date $(date -u -d "-$d day" +%F)
  done
"""
import argparse
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"

CATS = {
    68: {"sets": [("Test Sea Alpha", "TS01", "2026-08-28"), ("Test Sea Beta", "TS02", "2026-05-30")],
         "rar": ["C"] * 5 + ["UC"] * 3 + ["R"] * 3 + ["SR", "SR", "SEC", "L"], "subs": lambda r: ["Foil"] if r in ("SR", "SEC", "L") else ["Normal"],
         "names": ["Test Captain", "Test Navigator", "Test Swordsman", "Test Cook.D.Chef"], "num": "{a}-{i:03d}"},
    3: {"sets": [("Test Pocket Spark", "TPS", "2026-09-26"), ("Test Pocket Tide", "TPT", "2026-03-14")],
        "rar": ["Common"] * 5 + ["Uncommon"] * 3 + ["Rare", "Double Rare", "Illustration Rare", "Special Illustration Rare"],
        "subs": lambda r: ["Normal", "Reverse Holofoil"] if r in ("Common", "Uncommon") else ["Holofoil"],
        "names": ["Testachu", "Testmander", "Testtle", "Testasaur ex"], "num": "{i:03d}/120"},
    85: {"sets": [("Test Japan Bloom", "tjb", "2026-09-16")],
         "rar": ["C"] * 4 + ["U"] * 3 + ["R", "RR", "AR", "SR", "SAR"], "subs": lambda r: ["Holofoil"] if r not in ("C", "U") else ["Normal"],
         "names": ["Testachu", "Testevee", "Testgar"], "num": "{i:03d}/090"},
}
BASE = {"C": .2, "UC": .4, "R": 1.2, "SR": 6, "SEC": 45, "L": 3, "Common": .15, "Uncommon": .3, "Rare": 1,
        "Double Rare": 3, "Illustration Rare": 12, "Special Illustration Rare": 60, "U": .2, "RR": 2, "AR": 8, "SAR": 70}


def ext(**kw):
    return [{"name": k, "displayName": k, "value": v} for k, v in kw.items()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", type=int, default=0, help="days before today")
    day = ap.parse_args().day
    FIX.mkdir(parents=True, exist_ok=True)
    gid, pid = 90000, 800000
    for cat, spec in CATS.items():
        rnd = random.Random(cat)
        groups = []
        for name, abbr, date in spec["sets"]:
            gid += 1
            groups.append({"groupId": gid, "name": name, "abbreviation": abbr, "publishedOn": date + "T00:00:00", "categoryId": cat})
            products, prices = [], []
            for i in range(1, 31):
                pid += 1
                r = rnd.choice(spec["rar"])
                nm = rnd.choice(spec["names"]) + (" (Alternate Art)" if cat == 68 and i % 11 == 0 else "")
                products.append({"productId": pid, "name": nm, "groupId": gid, "categoryId": cat,
                                 "url": f"https://www.tcgplayer.com/product/{pid}",
                                 "extendedData": ext(Rarity=r, Number=spec["num"].format(a=abbr, i=i), Color="Red", CardType="Character")})
                if i % 9 == 0:
                    continue  # unpriced product
                for sub in spec["subs"](r):
                    walk = random.Random(f"{pid}{sub}")
                    drift = walk.uniform(-.02, .025)
                    m = round(BASE[r] * walk.uniform(.6, 1.8) * (1 - drift * day) * (1 + walk.uniform(-.02, .02) * (day % 3)), 2)
                    if sub == "Reverse Holofoil":
                        m = round(m * 1.6, 2)
                    row = {"productId": pid, "lowPrice": round(m * .9, 2), "midPrice": round(m * 1.1, 2), "highPrice": round(m * 2, 2),
                           "marketPrice": m, "directLowPrice": None, "subTypeName": sub}
                    if i % 13 == 0:
                        row.update(marketPrice=None, lowPrice=9999.99)  # junk listing, no sales
                    prices.append(row)
            for label, m in (("Booster Box", 110.0), ("Booster Pack", 4.2)):
                pid += 1
                products.append({"productId": pid, "name": f"{name} {label}", "groupId": gid, "categoryId": cat, "extendedData": []})
                walk = random.Random(pid)
                m = round(m * walk.uniform(.8, 1.4) * (1 - walk.uniform(-.015, .02) * day), 2)
                prices.append({"productId": pid, "lowPrice": m, "midPrice": m, "highPrice": m * 1.3, "marketPrice": m,
                               "directLowPrice": None, "subTypeName": "Normal"})
            (FIX / f"{cat}_{gid}_products.json").write_text(json.dumps({"results": products}))
            (FIX / f"{cat}_{gid}_prices.json").write_text(json.dumps({"results": prices}))
        (FIX / f"{cat}_groups.json").write_text(json.dumps({"results": groups}))
    print(f"fixtures for day -{day} in {FIX}")


if __name__ == "__main__":
    main()
