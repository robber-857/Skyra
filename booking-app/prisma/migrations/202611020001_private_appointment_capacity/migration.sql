-- Private sessions use their configured capacity, including 2:1 coaching.
-- Keep the general capacity checks, occupancy/oversell protections, coach and
-- location exclusions, and service-kind/Pass eligibility protections intact.
-- Existing catalogue and session capacity values are not changed.
ALTER TABLE "Service" DROP CONSTRAINT appointment_capacity_one;
DROP TRIGGER appointment_slot_capacity ON "ClassSession";
DROP FUNCTION protect_appointment_slot();
