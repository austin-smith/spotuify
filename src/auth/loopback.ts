import { REDIRECT_PORT } from "../config.ts";

export class AuthDeniedError extends Error {
  constructor(reason: string) {
    super(`Spotify denied the authorization request: ${reason}`);
    this.name = "AuthDeniedError";
  }
}

export class StateMismatchError extends Error {
  constructor() {
    super("OAuth state parameter did not match; discarding the response.");
    this.name = "StateMismatchError";
  }
}

export type CallbackOutcome =
  | { kind: "code"; code: string }
  | { kind: "denied"; reason: string }
  | { kind: "state-mismatch" }
  /** Not the redirect: a browser prefetch (/favicon.ico, /apple-touch-icon…) or a stray request. */
  | { kind: "ignore" };

/**
 * Classify an incoming request to the loopback server.
 *
 * Browsers routinely prefetch `/favicon.ico` and `/apple-touch-icon-precomposed.png` from the
 * callback host. Listeners that treat the *first* connection as the redirect fail with "no auth
 * code" when a prefetch wins the race. Anything without a `code` or `error` param is ignored so
 * the server keeps listening for the real redirect.
 */
export function classifyCallback(rawUrl: string, expectedState: string): CallbackOutcome {
  let url: URL;
  try {
    url = new URL(rawUrl, `http://127.0.0.1:${REDIRECT_PORT}`);
  } catch {
    return { kind: "ignore" };
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error === null && code === null) return { kind: "ignore" };

  // State is checked before anything else so a forged callback can't even report an error to us.
  if (url.searchParams.get("state") !== expectedState) return { kind: "state-mismatch" };
  if (error !== null) return { kind: "denied", reason: error };
  if (code === null || code.length === 0) return { kind: "ignore" };

  return { kind: "code", code };
}

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>spotuify</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>Authenticated. You can close this tab and return to your terminal.</p>`;

type Settled = { ok: true; code: string } | { ok: false; err: Error };

/**
 * Serve the OAuth redirect on 127.0.0.1 and resolve with the authorization code.
 *
 * Resolves only on a genuine redirect; rejects if Spotify reports an error, the state does not
 * match, or `signal` aborts. The listener is always torn down before returning.
 */
export async function awaitAuthCode(expectedState: string, signal?: AbortSignal): Promise<string> {
  let settle!: (result: Settled) => void;
  const outcome = new Promise<Settled>((resolve) => {
    settle = resolve;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: REDIRECT_PORT,
    fetch(req) {
      const result = classifyCallback(req.url, expectedState);
      switch (result.kind) {
        case "code":
          settle({ ok: true, code: result.code });
          return new Response(SUCCESS_PAGE, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        case "denied":
          settle({ ok: false, err: new AuthDeniedError(result.reason) });
          return new Response(`Authorization failed: ${result.reason}`, { status: 400 });
        case "state-mismatch":
          settle({ ok: false, err: new StateMismatchError() });
          return new Response("State mismatch", { status: 400 });
        case "ignore":
          return new Response("Not found", { status: 404 });
      }
    },
  });

  const onAbort = () => settle({ ok: false, err: new Error("Authorization was canceled.") });
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await outcome;
    if (!result.ok) throw result.err;
    return result.code;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Let the in-flight response flush before force-closing the connection.
    await Bun.sleep(50);
    await server.stop(true);
  }
}
