// Cron Vault credentials may differ from the runtime-injected service key.
// Never trust an unverified JWT role; compare with trusted server-side secrets.
export async function authorizeServiceRequest(req: Request, serviceKey: string,
  readCronSecret: () => Promise<string | null>): Promise<boolean> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ") || !serviceKey) return false;
  const token = header.slice(7);
  if (!token) return false;
  if (token === serviceKey) return true;
  try {
    const secret = await readCronSecret();
    return !!secret && token === secret;
  } catch { return false; }
}
