ALTER TABLE "CustomerProfile"
  ADD COLUMN "preferredName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "avatarBytes" BYTEA,
  ADD COLUMN "avatarMimeType" TEXT,
  ADD COLUMN "signature" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "trainingGoals" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CustomerProfile"
  ADD CONSTRAINT customer_profile_avatar_pair
  CHECK (("avatarBytes" IS NULL) = ("avatarMimeType" IS NULL));

ALTER TABLE "CustomerProfile"
  ADD CONSTRAINT customer_profile_avatar_type
  CHECK ("avatarMimeType" IS NULL OR "avatarMimeType" IN ('image/png', 'image/jpeg', 'image/webp'));

ALTER TABLE "CustomerProfile"
  ADD CONSTRAINT customer_profile_avatar_size
  CHECK ("avatarBytes" IS NULL OR octet_length("avatarBytes") <= 524288);
