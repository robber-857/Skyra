ALTER TABLE "BookingChange" DROP CONSTRAINT "BookingChange_action_check";
ALTER TABLE "BookingChange" ADD CONSTRAINT "BookingChange_action_check"
CHECK (action IN (
  'CANCEL', 'CANCEL_WAIVE', 'CHECK_IN', 'COMPLETE', 'NO_SHOW',
  'RESCHEDULE', 'AUTO_COMPLETE', 'BACKFILL_ATTENDANCE'
));
