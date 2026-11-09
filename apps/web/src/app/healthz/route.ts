// Liveness for the container healthcheck; touches nothing else.
export const dynamic = 'force-dynamic';
export const GET = () => new Response('ok', { headers: { 'content-type': 'text/plain' } });
