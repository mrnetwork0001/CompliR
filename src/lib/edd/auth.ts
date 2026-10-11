/** Internal-caller check shared by EDD routes: `Authorization: Bearer $CRON_SECRET` or a same-origin browser call. */
export function isInternalCaller(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") === `Bearer ${secret}`) return true;
  return req.headers.get("sec-fetch-site") === "same-origin";
}
