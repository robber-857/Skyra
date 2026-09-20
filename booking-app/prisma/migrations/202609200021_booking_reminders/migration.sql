ALTER TABLE "BookingNotification"
  DROP CONSTRAINT "BookingNotification_template_check";

ALTER TABLE "BookingNotification"
  ADD CONSTRAINT "BookingNotification_template_check"
  CHECK(template IN (
    'BOOKING_CONFIRMED_V1',
    'BOOKING_CANCELLED_V1',
    'BOOKING_REMINDER_V1'
  ));
