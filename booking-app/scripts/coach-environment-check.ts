import db from "../app/db.server";

// Read-only. Run with the target host's existing DATABASE_URL; never copy a
// production database credential into a report or commit it to this repo.
const domain =
  process.env.SKYRA_COACH_LOGIN_SHOP || "skyra-booking-dev.myshopify.com";
try {
  const database = new URL(process.env.DATABASE_URL!);
  const shop = await db.shop.findUnique({ where: { domain } });
  const coaches = shop
    ? await db.coach.findMany({
        where: {
          shopId: shop.id,
          name: { equals: "Karen", mode: "insensitive" },
        },
        select: {
          id: true,
          name: true,
          status: true,
          loginEmail: true,
          loginVerifiedAt: true,
          notificationEmail: true,
          sessions: {
            select: {
              id: true,
              startsAt: true,
              endsAt: true,
              timezone: true,
              status: true,
              capacity: true,
              service: { select: { name: true } },
            },
            orderBy: { startsAt: "asc" },
          },
        },
      })
    : [];
  console.log(
    JSON.stringify(
      {
        databaseHost: database.hostname,
        databaseName: database.pathname.slice(1),
        revision: process.env.RENDER_GIT_COMMIT || null,
        domain,
        shopFound: Boolean(shop),
        coaches: coaches.map((coach) => ({
          ...coach,
          loginEmail: Boolean(coach.loginEmail),
          notificationEmail: Boolean(coach.notificationEmail),
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await db.$disconnect();
}
