// The headers that reached the app, to see X-Forwarded-Host with the rewrite off.
export const GET = (request: Request) => Response.json({ url: request.url, headers: Object.fromEntries(request.headers) });
