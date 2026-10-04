ALTER TABLE "PassPlan"
  ADD COLUMN "sellingPlanGroupGid" TEXT,
  ADD COLUMN "renewalSetupState" TEXT NOT NULL DEFAULT 'NONE';
