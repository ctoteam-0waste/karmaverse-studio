import { activeBrand, readDb } from "@/lib/db";
import { exportCalendarCsv } from "@/lib/publishing/adapters";
import { todayIst } from "@/lib/util";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await readDb();
  const brand = activeBrand(db);
  const csv = exportCalendarCsv(db.content.filter((c) => c.brandId === brand.id));
  // BOM so Excel on Windows opens UTF-8 (emoji, Hindi) correctly.
  return new Response(`﻿${csv}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${brand.name.replace(/\W+/g, "-")}-calendar-${todayIst()}.csv"`,
    },
  });
}
