ALTER TABLE "BookingChange"
DROP CONSTRAINT "BookingChange_actorKind_check";

ALTER TABLE "BookingChange"
ADD CONSTRAINT "BookingChange_actorKind_check"
CHECK ("actorKind" IN ('STAFF', 'COACH', 'CUSTOMER', 'SYSTEM'));

ALTER TABLE "BookingChange"
DROP CONSTRAINT "BookingChange_action_check";

ALTER TABLE "BookingChange"
ADD CONSTRAINT "BookingChange_action_check"
CHECK (action IN (
  'CANCEL',
  'CANCEL_WAIVE',
  'CHECK_IN',
  'COMPLETE',
  'NO_SHOW',
  'RESCHEDULE',
  'AUTO_COMPLETE'
));
