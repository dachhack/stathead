// Bearer-token auth. API_TOKENS is `client:token,client2:token2`; ADMIN_TOKEN
// gates the store writes the daily job makes. Tokens compare in constant time.

export interface AuthEnv {
  API_TOKENS?: string;
  ADMIN_TOKEN?: string;
}

export interface Principal {
  client: string;
  admin: boolean;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i % (ea.length || 1)] ?? 0) ^ (eb[i % (eb.length || 1)] ?? 0);
  return diff === 0;
}

export function parseTokens(spec: string | undefined): Array<{ client: string; token: string }> {
  return (spec ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':');
      return i < 0 ? { client: 'default', token: pair } : { client: pair.slice(0, i), token: pair.slice(i + 1) };
    })
    .filter((t) => t.token.length >= 16);
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/** Resolve the caller, or null when the token is missing or unknown. */
export function authenticate(req: Request, env: AuthEnv): Principal | null {
  const token = bearer(req);
  if (!token) return null;
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16 && constantTimeEqual(token, env.ADMIN_TOKEN)) return { client: 'admin', admin: true };
  for (const t of parseTokens(env.API_TOKENS)) {
    if (constantTimeEqual(token, t.token)) return { client: t.client, admin: false };
  }
  return null;
}
