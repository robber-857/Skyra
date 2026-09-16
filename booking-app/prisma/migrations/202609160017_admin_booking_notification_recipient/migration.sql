ALTER TABLE "BookingNotification"
  DROP CONSTRAINT "BookingNotification_recipientKind_check";

ALTER TABLE "BookingNotification"
  ADD CONSTRAINT "BookingNotification_recipientKind_check"
  CHECK ("recipientKind" IN ('CUSTOMER', 'COACH', 'ADMIN'));
