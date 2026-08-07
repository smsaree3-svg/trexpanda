// Shared CORS headers for the billing Edge Functions.
// The desktop app calls these from the Electron main process (server-to-server),
// so CORS isn't strictly required — but including it keeps the functions usable
// from a browser (e.g. a future web dashboard) and makes local testing painless.

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
