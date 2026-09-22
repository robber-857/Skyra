import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime

scripts=Path(__file__).resolve().parents[1]/"scripts"
sys.path.insert(0,str(scripts))
spec=importlib.util.spec_from_file_location("prepare_mindbody",scripts/"prepare-mindbody.py")
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PrepareTests(unittest.TestCase):
    def source(self):
        return {
          "Current Pass balances":[{},
            {"A":"synthetic-client","F":"SKYRA Lifestyle","G":"46282","H":"46373","I":"36","M":"36","N":"0"},
            {"A":"synthetic-private","F":"1:1 Private Aerial Yoga Single Pass","G":"46282","H":"46400","I":"11","M":"7","N":"0"},
            {"A":"synthetic-mv","F":"Skyra K-Pop MV Project","G":"46282","H":"46400","I":"5","M":"4","N":"0"}],
          "Future bookings":[{}],
          "Lifestyle tranches":[{},
            {"A":"synthetic-sale","C":"1","D":"46282","E":"46312","F":"12"},
            {"A":"synthetic-sale","C":"2","D":"46312","E":"46343","F":"12"},
            {"A":"synthetic-sale","C":"3","D":"46343","E":"46373","F":"12"}]}
    def test_tranches_and_legacy_opening_balances(self):
        with patch.object(module,"read_workbook",return_value=self.source()):
            cutoff=datetime.fromisoformat("2026-09-21T12:00:00+10:00")
            mapping=module.prepare(None,cutoff,None,"synthetic")
            mapping.update(shopId="synthetic-shop",locationId="synthetic-location",legacyMappingsConfirmed=True)
            for kind in ["customers","passPlans","services","coaches"]:
                mapping[kind]={k:"synthetic-"+str(i) for i,k in enumerate(mapping[kind])}
            result=module.prepare(None,cutoff,mapping,"synthetic")
            self.assertEqual(len(result["passes"]),5)
            tranches=[p for p in result["passes"] if p["passKey"]=="SKYRA Lifestyle"]
            self.assertEqual([p["available"] for p in tranches],[12,12,12])
            self.assertEqual(tranches[0]["expiresAt"],tranches[1]["startsAt"])
            self.assertEqual(tranches[1]["expiresAt"],tranches[2]["startsAt"])
            private=next(p for p in result["passes"] if p["passKey"]=="legacy-private-10")
            self.assertEqual((private["available"],private["reserved"],private["consumed"]),(7,0,3))
            self.assertEqual(private["serviceKind"],"APPOINTMENT")
            self.assertTrue(private["legacyOnly"])
            mv=next(p for p in result["passes"] if p["passKey"]=="legacy-restricted-mv")
            self.assertEqual(mv["serviceKind"],"COURSE")
            self.assertTrue(mv["legacyOnly"])
    def test_named_mv_project_keeps_restricted_course_scope(self):
        source=self.source()
        source["Current Pass balances"][3]["F"]="Skyra K-Pop MV Project ( Synthetic Project)"
        with patch.object(module,"read_workbook",return_value=source):
            cutoff=datetime.fromisoformat("2026-09-22T00:00:00+10:00")
            mapping=module.prepare(None,cutoff,None,"synthetic")
            self.assertIn("legacy-restricted-mv",mapping["passPlans"])
            mapping.update(shopId="synthetic-shop",locationId="synthetic-location",legacyMappingsConfirmed=True)
            for kind in ["customers","passPlans","services","coaches"]:
                mapping[kind]={k:"synthetic-"+str(i) for i,k in enumerate(mapping[kind])}
            result=module.prepare(None,cutoff,mapping,"synthetic")
            mv=next(p for p in result["passes"] if p["passKey"]=="legacy-restricted-mv")
            self.assertEqual(mv["serviceKind"],"COURSE")
            self.assertTrue(mv["legacyOnly"])
            self.assertEqual((mv["available"],mv["consumed"]),(4,1))
    def test_missing_mapping_blocks(self):
        with patch.object(module,"read_workbook",return_value=self.source()):
            with self.assertRaises(ValueError):
                module.prepare(None,datetime.fromisoformat("2026-09-21T12:00:00+10:00"),{"targetShop":module.SHOP},"synthetic")
    def scheduled_source(self):
        source = self.source()
        source["Current Pass balances"] = [{}] + [
            {"A":f"synthetic-aerial-{i}","F":"5 Aerial Access","G":"46282","H":"46400","I":"5","M":"4","N":"1"}
            for i in range(2)]
        source["Future bookings"] = [{}] + [
            {"A":"46291","B":"0.5","C":str(0.5+55/1440),"D":"Synthetic Aerial","E":"Synthetic Coach",
             "G":f"synthetic-aerial-{i}","J":"5 Aerial Access","N":"MATCHED"}
            for i in range(2)]
        return source
    def scheduled_mapping(self, cutoff):
        mapping=module.prepare(None,cutoff,None,"synthetic")
        mapping.update(shopId="synthetic-shop",locationId="synthetic-location",legacyMappingsConfirmed=True)
        for kind in ["customers","passPlans","services","coaches"]:
            mapping[kind]={k:"synthetic-"+str(i) for i,k in enumerate(mapping[kind])}
        return mapping
    def test_approved_capacity_preserves_available_seats_and_credit_balances(self):
        with patch.object(module,"read_workbook",return_value=self.scheduled_source()):
            cutoff=datetime.fromisoformat("2026-09-22T00:00:00+10:00")
            mapping=self.scheduled_mapping(cutoff)
            mapping["serviceCapacities"]={"Synthetic Aerial":6}
            result=module.prepare(None,cutoff,mapping,"synthetic")
            self.assertEqual(len(result["sessions"]),1)
            self.assertEqual(result["sessions"][0]["capacity"],6)
            self.assertEqual(len(result["bookings"]),2)
            self.assertEqual(sum(p["available"] for p in result["passes"]),8)
            self.assertEqual(sum(p["reserved"] for p in result["passes"]),2)
    def test_missing_capacity_keeps_reserved_count_fallback(self):
        with patch.object(module,"read_workbook",return_value=self.scheduled_source()):
            cutoff=datetime.fromisoformat("2026-09-22T00:00:00+10:00")
            mapping=self.scheduled_mapping(cutoff)
            for capacities in [None,{}, {"Another Service":6}]:
                with self.subTest(capacities=capacities):
                    if capacities is not None: mapping["serviceCapacities"]=capacities
                    result=module.prepare(None,cutoff,mapping,"synthetic")
                    self.assertEqual(result["sessions"][0]["capacity"],2)
    def test_invalid_capacity_is_rejected(self):
        with patch.object(module,"read_workbook",return_value=self.scheduled_source()):
            cutoff=datetime.fromisoformat("2026-09-22T00:00:00+10:00")
            mapping=self.scheduled_mapping(cutoff)
            invalid=[None,[],6]+[{"Synthetic Aerial":value} for value in [None,True,False,0,-1,201,6.0,"6"]]
            for capacities in invalid:
                with self.subTest(capacities=capacities):
                    mapping["serviceCapacities"]=capacities
                    with self.assertRaisesRegex(ValueError,"^INVALID_SERVICE_CAPACITY$"):
                        module.prepare(None,cutoff,mapping,"synthetic")
    def test_capacity_below_reserved_is_rejected(self):
        with patch.object(module,"read_workbook",return_value=self.scheduled_source()):
            cutoff=datetime.fromisoformat("2026-09-22T00:00:00+10:00")
            mapping=self.scheduled_mapping(cutoff)
            mapping["serviceCapacities"]={"Synthetic Aerial":1}
            with self.assertRaisesRegex(ValueError,"^SERVICE_CAPACITY_BELOW_RESERVED$"):
                module.prepare(None,cutoff,mapping,"synthetic")
    def test_private_outputs_cannot_enter_repository(self):
        with self.assertRaises(ValueError): module.outside(scripts/"private.json")

if __name__=="__main__": unittest.main()
