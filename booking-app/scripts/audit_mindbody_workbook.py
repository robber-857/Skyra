"""Read the private reconciliation workbook; emit aggregate validation only.

No customer rows, IDs or source values are printed. Source XLSX is never modified.
"""
import argparse
import datetime as dt
import json
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

def read_workbook(path):
    with zipfile.ZipFile(path) as archive:
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ["".join(item.itertext()) for item in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("s:si", NS)]
        rels = {r.attrib["Id"]: r.attrib["Target"] for r in ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
        sheets = ET.fromstring(archive.read("xl/workbook.xml")).findall("s:sheets/s:sheet", NS)
        result = {}
        for sheet in sheets:
            target = rels[sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]]
            target = target.lstrip("/") if target.startswith("/") else "xl/" + target
            rows = []
            for row in ET.fromstring(archive.read(target)).findall("s:sheetData/s:row", NS):
                values = {}
                for cell in row:
                    col = "".join(c for c in cell.attrib["r"] if c.isalpha())
                    raw = cell.find("s:v", NS)
                    value = raw.text if raw is not None else "".join(cell.itertext())
                    if cell.attrib.get("t") == "s": value = strings[int(value)]
                    values[col] = value
                rows.append(values)
            result[sheet.attrib["name"]] = rows
        return result

def excel_day(value):
    return (dt.datetime(1899, 12, 30) + dt.timedelta(days=float(value))).date()

def audit(path, cutoff_date):
    sheets = read_workbook(path)
    balances = sheets["Current Pass balances"][1:]
    bookings = sheets["Future bookings"][1:]
    tranches = sheets["Lifestyle tranches"][1:]
    active = [r for r in balances if excel_day(r["H"]) >= cutoff_date]
    errors = []
    if any(int(float(r["M"])) + int(float(r["N"])) != int(float(r["O"])) for r in balances): errors.append("BALANCE_SUM_MISMATCH")
    if any(r.get("N") != "MATCHED" for r in bookings): errors.append("BOOKING_PASS_UNMATCHED")
    future = [r for r in bookings if excel_day(r["A"]) >= cutoff_date]
    reserved = Counter((r["G"], r["J"]) for r in future)
    for row in active:
        if reserved[(row["A"],row["F"])] != int(float(row["N"])): errors.append("CUTOFF_RESERVATIONS_REQUIRE_DELTA")
    lifestyle = [r for r in active if r["F"] == "SKYRA Lifestyle"]
    if len(lifestyle) != 1 or len(tranches) != 3 or any(int(float(t["F"])) != 12 for t in tranches): errors.append("LIFESTYLE_TRANCHE_MISMATCH")
    if any(tranches[i]["E"] != tranches[i+1]["D"] for i in range(len(tranches)-1)): errors.append("LIFESTYLE_INTERVAL_GAP")
    # Dates in source expiration columns are inclusive; tranche ends are explicitly exclusive.
    active_tranches = [t for t in tranches if excel_day(t["E"]) > cutoff_date]
    return {"mode":"WORKBOOK_AUDIT_ONLY", "cutoffDate":str(cutoff_date), "sourceBalanceRows":len(balances),
        "expiredArchiveRows":len(sheets["Expired Pass archive"])-1, "eligibleBalanceRows":len(active),
        "plannedEntitlements":len(active)-len(lifestyle)+len(active_tranches),
        "available":sum(int(float(r["M"])) for r in active), "reserved":sum(int(float(r["N"])) for r in active),
        "futureBookings":len(future), "futureCustomers":len({r["G"] for r in future}),
        "futureSessions":len({(r["A"],r["B"],r["D"],r["E"]) for r in future}),
        "legacyMappingsRequired":["private-10", "private-5", "restricted-mv-project"],
        "errors":sorted(set(errors)), "databaseDryRun":False}

if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--workbook",required=True)
    parser.add_argument("--cutoff-date",required=True,type=dt.date.fromisoformat)
    args=parser.parse_args()
    try:
        result=audit(Path(args.workbook),args.cutoff_date)
        print(json.dumps(result))
        raise SystemExit(1 if result["errors"] else 0)
    except (ValueError,KeyError,OSError,zipfile.BadZipFile):
        print(json.dumps({"error":"WORKBOOK_INPUT_INVALID"}))
        raise SystemExit(1)
