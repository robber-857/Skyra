import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import type { BookingActor } from "./booking.server";

const plainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) =>
        Array.from(value).every(
          (character) =>
            character.charCodeAt(0) >= 32 ||
            [9, 10, 13].includes(character.charCodeAt(0)),
        ),
      "Use plain text.",
    );

const updateInput = z
  .object({
    preferredName: plainText(80),
    signature: plainText(160),
    trainingGoals: plainText(1000),
    avatarDataUrl: z.string().max(700000).nullable(),
  })
  .strict();

function requireCustomer(actor: BookingActor) {
  if (!actor.customerGid)
    throw new DomainError(
      "LOGIN_REQUIRED",
      "Sign in to manage your profile.",
      401,
    );
  return actor.customerGid;
}

function avatarData(value: string | null): {
  avatarBytes: Uint8Array<ArrayBuffer> | null;
  avatarMimeType: string | null;
} {
  if (value === null) return { avatarBytes: null, avatarMimeType: null };
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      value,
    );
  if (!match)
    throw new DomainError(
      "INVALID_AVATAR",
      "Choose a PNG, JPEG or WebP image.",
      400,
    );
  const decoded = Buffer.from(match[2], "base64");
  if (!decoded.length || decoded.length > 524288)
    throw new DomainError(
      "INVALID_AVATAR",
      "Choose an image no larger than 512 KB.",
      400,
    );
  const mimeType = match[1];
  const valid =
    (mimeType === "image/png" &&
      decoded.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (mimeType === "image/jpeg" &&
      decoded.length >= 3 &&
      decoded[0] === 0xff &&
      decoded[1] === 0xd8 &&
      decoded[2] === 0xff) ||
    (mimeType === "image/webp" &&
      decoded.subarray(0, 4).toString("ascii") === "RIFF" &&
      decoded.subarray(8, 12).toString("ascii") === "WEBP");
  if (!valid)
    throw new DomainError(
      "INVALID_AVATAR",
      "That file is not a valid PNG, JPEG or WebP image.",
      400,
    );
  const avatarBytes = new Uint8Array(decoded.length);
  avatarBytes.set(decoded);
  return { avatarBytes, avatarMimeType: mimeType };
}

function response(
  profile: {
    preferredName: string;
    avatarBytes: Uint8Array | null;
    avatarMimeType: string | null;
    signature: string;
    trainingGoals: string;
  } | null,
) {
  return {
    preferredName: profile?.preferredName || "",
    avatarDataUrl:
      profile?.avatarBytes && profile.avatarMimeType
        ? `data:${profile.avatarMimeType};base64,${Buffer.from(
            profile.avatarBytes,
          ).toString("base64")}`
        : null,
    signature: profile?.signature || "",
    trainingGoals: profile?.trainingGoals || "",
  };
}

export async function customerProfileData(actor: BookingActor) {
  const customerGid = requireCustomer(actor);
  const profile = await db.customerProfile.findUnique({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: actor.shopId,
        shopifyCustomerGid: customerGid,
      },
    },
    select: {
      preferredName: true,
      avatarBytes: true,
      avatarMimeType: true,
      signature: true,
      trainingGoals: true,
    },
  });
  return response(profile);
}

export async function updateCustomerProfile(actor: BookingActor, raw: unknown) {
  const customerGid = requireCustomer(actor);
  const input = updateInput.parse(raw);
  const avatar = avatarData(input.avatarDataUrl);
  const profile = await db.customerProfile.upsert({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: actor.shopId,
        shopifyCustomerGid: customerGid,
      },
    },
    create: {
      shopId: actor.shopId,
      shopifyCustomerGid: customerGid,
      preferredName: input.preferredName,
      signature: input.signature,
      trainingGoals: input.trainingGoals,
      ...avatar,
    },
    update: {
      preferredName: input.preferredName,
      signature: input.signature,
      trainingGoals: input.trainingGoals,
      ...avatar,
    },
    select: {
      preferredName: true,
      avatarBytes: true,
      avatarMimeType: true,
      signature: true,
      trainingGoals: true,
    },
  });
  return response(profile);
}
