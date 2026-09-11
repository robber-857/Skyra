import "dotenv/config";
import db from "../app/db.server";
const domain = process.env.SEED_SHOP || "skyra-booking-local.myshopify.com";
if (!domain.endsWith("-local.myshopify.com")) throw new Error("Seed only supports explicitly local fixtures, never live store data.");
const shop = await db.shop.upsert({ where: { domain }, create: { domain }, update: {} });
const location = await db.location.upsert({ where: { shopId_name: { shopId: shop.id, name: "Development Studio" } }, create: { shopId: shop.id, name: "Development Studio" }, update: {} });
const coach = await db.coach.findFirst({ where: { shopId: shop.id, name: "Development Coach" } }) || await db.coach.create({ data: { shopId: shop.id, name: "Development Coach" } });
console.log("Local seed ready:", { shopId: shop.id, locationId: location.id, coachId: coach.id });
await db.$disconnect();

