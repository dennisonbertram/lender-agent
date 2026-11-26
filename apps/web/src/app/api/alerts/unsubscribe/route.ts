// The link in every alert email (BP-21). The token is the credential; no sign-in.
// GET only shows a confirmation page, so a link scanner that opens the link cannot turn alerts off.
// POST turns email off: the page's button, and the RFC 8058 one-click request mail clients send (List-Unsubscribe-Post).
import { getDb } from "@/server/db/client";
import { unsubscribeByToken } from "@/server/email/prefs";

export const dynamic = "force-dynamic";

const page = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Lender agent</title><main style="font:16px system-ui;margin:2rem">${body}</main>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const tokenOf = (req: Request) => new URL(req.url).searchParams.get("token") ?? "";

export async function GET(req: Request): Promise<Response> {
  const action = `/api/alerts/unsubscribe?token=${encodeURIComponent(tokenOf(req))}`;
  return page(`<p>Turn off alert emails?</p><form method="post" action="${action.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"><button type="submit">Turn off alert emails</button></form>`);
}

export async function POST(req: Request): Promise<Response> {
  const ok = await unsubscribeByToken(await getDb(), tokenOf(req));
  return page(ok ? "<p>Alert emails are off. You can turn them back on in Settings.</p>" : "<p>This link is not valid.</p>", ok ? 200 : 404);
}
