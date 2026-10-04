ALTER TABLE "MembershipReceipt" DROP CONSTRAINT "MembershipReceipt_terms_check";
ALTER TABLE "MembershipReceipt" ADD CONSTRAINT "MembershipReceipt_terms_check" CHECK (
  "cycle" > 0 AND "priceCents" >= 0 AND "credits" > 0 AND "validityDays" > 0
  AND ("validityMonths" IS NULL OR "validityMonths" > 0)
);
