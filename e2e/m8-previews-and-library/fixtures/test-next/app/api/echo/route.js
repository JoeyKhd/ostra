// The headers that reached the app, so a test sees `Host` rewritten, or `X-Forwarded-Host` with the rewrite off (Q304).
export const GET = (request) => Response.json({ url: request.url, headers: Object.fromEntries(request.headers) });
