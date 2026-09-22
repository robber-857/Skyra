"""Prepare an importer manifest using explicit production IDs; all files stay outside Git.

A mapping template contains private source keys. Never commit it. Existing original
workbooks are read-only. Missing mappings stop generation instead of guessing IDs.
"""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from zoneinfo import ZoneInfo
from audit_mindbody_workbook import read_workbook, excel_day

SHOP = "mf0n6s-zg.myshopify.com"
REPO = Path(__file__).resolve().parents[2]
ZONE = ZoneInfo("Australia/Sydney")

def outside(path):
    resolved = Path(path).resolve()
    if resolved == REPO or REPO in resolved.parents:
        raise ValueError("PRIVATE_FILE_INSIDE_REPOSITORY")
    return resolved

def midnight(day):
    return dt.datetime.combine(day, dt.time(), ZONE)

def label(row):
    name = row["F"]
    if "1:1 Private Aerial" in name:
        return {11:"legacy-private-10",5:"legacy-private-5"}[int(float(row["I"]))]
    if name == "Skyra K-Pop MV Project" or (name.startswith("Skyra K-Pop MV Project (") and name.endswith(")")):
        return "legacy-restricted-mv"
    return name

def prepare(workbook, cutoff, mapping, batch_key):
    sheets = read_workbook(workbook)
    rows = [r for r in sheets["Current Pass balances"][1:] if midnight(excel_day(r["H"]) + dt.timedelta(days=1)) > cutoff]
    schedule = [r for r in sheets["Future bookings"][1:] if midnight(excel_day(r["A"])) + dt.timedelta(days=float(r["B"])) > cutoff]
    template = {"targetShop":SHOP, "shopId":None, "locationId":None,
        "customers":{r["A"]:None for r in rows}, "passPlans":{label(r):None for r in rows},
        "services":{r["D"]:None for r in schedule}, "coaches":{r["E"]:None for r in schedule},
        "legacyMappingsConfirmed":False, "approvedCustomerMerges":[]}
    if mapping is None: return template
    if mapping.get("targetShop") != SHOP or not mapping.get("legacyMappingsConfirmed"):
        raise ValueError("PRODUCTION_AND_LEGACY_MAPPING_REVIEW_REQUIRED")
    if not mapping.get("shopId") or not mapping.get("locationId"): raise ValueError("MISSING_PRODUCTION_MAPPING")
    for kind in ["customers","passPlans","services","coaches"]:
        if any(not mapping.get(kind,{}).get(key) for key in template[kind]): raise ValueError("MISSING_PRODUCTION_MAPPING")
    capacities = mapping.get("serviceCapacities", {})
    if not isinstance(capacities, dict) or any(type(value) is not int or not 1 <= value <= 200 for value in capacities.values()):
        raise ValueError("INVALID_SERVICE_CAPACITY")
    manifest = {"version":1,"sourceSystem":"MIND_BODY","targetShop":SHOP,"shopId":mapping["shopId"],"batchKey":batch_key,"cutoff":cutoff.isoformat(),
        "customers":[{"externalKey":key,"customerId":mapping["customers"][key],"mergeApproved":key in mapping.get("approvedCustomerMerges",[])} for key in template["customers"]],
        "mappings":[{"entityType":"LOCATION","externalKey":"burwood","targetId":mapping["locationId"]}],"passes":[],"sessions":[],"bookings":[]}
    for kind,entity in [("passPlans","PASS_PLAN"),("services","SERVICE"),("coaches","COACH")]:
        manifest["mappings"].extend({"entityType":entity,"externalKey":key,"targetId":mapping[kind][key]} for key in template[kind])
    matched = {}
    for row in rows:
        external = json.dumps([row["A"],row["F"],str(excel_day(row["G"]))],ensure_ascii=False,separators=(',',':'))
        available,reserved = int(float(row["M"])),int(float(row["N"]))
        purchased = 10 if label(row)=="legacy-private-10" else int(float(row["I"]))
        if purchased < available+reserved: raise ValueError("INVALID_OPENING_BALANCE")
        if row["F"] == "SKYRA Lifestyle":
            for tranche in sheets["Lifestyle tranches"][1:]:
                if midnight(excel_day(tranche["E"])) <= cutoff: continue
                manifest["passes"].append({"externalKey":f"lifestyle:{tranche['A']}:{tranche['C']}","customerKey":row["A"],"passKey":label(row),
                    "startsAt":midnight(excel_day(tranche["D"])).isoformat(),"expiresAt":midnight(excel_day(tranche["E"])).isoformat(),
                    "available":int(float(tranche["F"])),"reserved":0,"consumed":0})
        else:
            manifest["passes"].append({"externalKey":external,"customerKey":row["A"],"passKey":label(row),
                "startsAt":midnight(excel_day(row["G"])).isoformat(),"expiresAt":midnight(excel_day(row["H"])+dt.timedelta(days=1)).isoformat(),
                "available":available,"reserved":reserved,"consumed":purchased-available-reserved, "legacyOnly":label(row).startswith("legacy-"), "serviceKind":"APPOINTMENT" if label(row).startswith("legacy-private") else "COURSE" if label(row)=="legacy-restricted-mv" else "CLASS"})
            if (row["A"],row["F"]) in matched: raise ValueError("AMBIGUOUS_PASS_MATCH")
            matched[(row["A"],row["F"])] = external
    sessions={}
    for row in schedule:
        start=midnight(excel_day(row["A"]))+dt.timedelta(days=float(row["B"]))
        end=midnight(excel_day(row["A"]))+dt.timedelta(days=float(row["C"]))
        key=json.dumps([row["D"],row["E"],start.isoformat(),"burwood"],ensure_ascii=False,separators=(',',':'))
        if key not in sessions:
            sessions[key]={"externalKey":key,"serviceKey":row["D"],"coachKey":row["E"],"locationKey":"burwood","startsAt":start.isoformat(),"endsAt":end.isoformat(),"capacity":0}
        sessions[key]["capacity"]+=1
        if row.get("N")!="MATCHED" or (row["G"],row["J"]) not in matched: raise ValueError("BOOKING_PASS_UNMATCHED")
        manifest["bookings"].append({"externalKey":json.dumps([row["G"],key],ensure_ascii=False),"customerKey":row["G"],"passKey":matched[(row["G"],row["J"])],"sessionKey":key})
    for session in sessions.values():
        if session["serviceKey"] in capacities:
            capacity = capacities[session["serviceKey"]]
            if capacity < session["capacity"]: raise ValueError("SERVICE_CAPACITY_BELOW_RESERVED")
            session["capacity"] = capacity
    manifest["sessions"]=list(sessions.values())
    for row in manifest["passes"]:
        if row["reserved"]!=sum(b["passKey"]==row["externalKey"] for b in manifest["bookings"]): raise ValueError("CUTOFF_DELTA_REQUIRED")
    return manifest

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--workbook",required=True)
    parser.add_argument("--cutoff",required=True)
    parser.add_argument("--mapping")
    parser.add_argument("--out",required=True)
    parser.add_argument("--batch-key",required=True)
    args=parser.parse_args()
    try:
        cutoff=dt.datetime.fromisoformat(args.cutoff)
        if cutoff.tzinfo is None: raise ValueError("TIMEZONE_REQUIRED")
        workbook=outside(args.workbook);output=outside(args.out)
        mapping=json.loads(outside(args.mapping).read_text(encoding="utf-8")) if args.mapping else None
        result=prepare(workbook,cutoff,mapping,args.batch_key)
        # Exclusive creation prevents overwriting a reviewed mapping, workbook or prior manifest.
        with output.open("x",encoding="utf-8") as stream: json.dump(result,stream,ensure_ascii=False,indent=2)
        print(json.dumps({"status":"MANIFEST_PREPARED" if mapping else "MAPPING_TEMPLATE_REQUIRES_PRODUCTION_IDS","containsPrivateData":True}))
    except (ValueError,KeyError,OSError):
        print(json.dumps({"status":"BLOCKED","code":"INPUT_OR_PRODUCTION_MAPPING_REQUIRES_REVIEW"}))
        sys.exit(1)
