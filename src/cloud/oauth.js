'use strict';

/**
 * Desktop OAuth via a loopback redirect (PKCE).
 *
 * Browsers/Supabase can't redirect straight back into an Electron app, so we:
 *   1. spin up a throwaway HTTP server on 127.0.0.1:<port>,
 *   2. ask Supabase for the provider's authorize URL with redirectTo pointing
 *      at that loopback address (skipBrowserRedirect so WE open it),
 *   3. open the URL in the user's real browser,
 *   4. catch the `?code=...` the provider sends back to the loopback server,
 *   5. exchange it for a session with exchangeCodeForSession().
 *
 * The fixed port keeps setup simple: you allowlist exactly one redirect URL
 * (http://localhost:8765/callback) in your Supabase project.
 */

const http = require('http');

const DEFAULT_PORT = 8765;
const CALLBACK_PATH = '/callback';

function page(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1420;color:#e6ebf5;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;max-width:420px;padding:28px 32px;border:1px solid #2a3346;border-radius:12px;background:#171d2b}
h1{font-size:20px;margin:0 0 8px}p{color:#8a94a8;margin:0}</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * Run the loopback OAuth handshake for a given provider.
 * @returns {Promise<object>} the exchanged session data
 */
function loopbackOAuth({ client, provider, openExternal, port = DEFAULT_PORT, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch (_) {}
      fn(arg);
    };

    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url, `http://localhost:${port}`); } catch (_) { res.writeHead(400); res.end(); return; }
      if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end('Not found'); return; }

      const err = url.searchParams.get('error_description') || url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page('Sign-in failed', err));
        finish(reject, new Error(err));
        return;
      }
      if (!code) { res.writeHead(400); res.end('Missing authorization code'); return; }

      try {
        const { data, error } = await client.auth.exchangeCodeForSession(code);
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(page('Sign-in failed', error.message || String(error)));
          finish(reject, error);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page('Signed in ✓', 'You can close this tab and return to Trexpanda.'));
        finish(resolve, data);
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page('Sign-in failed', String(e.message || e)));
        finish(reject, e);
      }
    });

    const timer = setTimeout(
      () => finish(reject, new Error('Timed out waiting for the browser sign-in to complete.')),
      timeoutMs
    );

    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        finish(reject, new Error(`Port ${port} is in use. Close whatever is using it and try again.`));
      } else {
        finish(reject, e);
      }
    });

    server.listen(port, '127.0.0.1', async () => {
      try {
        const redirectTo = `http://localhost:${port}${CALLBACK_PATH}`;
        const { data, error } = await client.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo,
            skipBrowserRedirect: true,
            queryParams: { access_type: 'offline', prompt: 'consent' },
          },
        });
        if (error) return finish(reject, error);
        if (!data || !data.url) return finish(reject, new Error('Could not start the sign-in flow.'));
        await openExternal(data.url);
      } catch (e) {
        finish(reject, e);
      }
    });
  });
}

module.exports = { loopbackOAuth, DEFAULT_PORT, CALLBACK_PATH };
