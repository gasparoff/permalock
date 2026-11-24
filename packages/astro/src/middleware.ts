// Answers 410 Gone for URLs declared removed in permalock.json, for sites
// with on-demand rendering. Static hosts get the same through `permalock emit`.
// @ts-ignore virtual module provided by the integration
import gone from 'virtual:permalock/gone';

const goneSet: Set<string> = new Set(gone as string[]);

export const onRequest = (context: { url: URL }, next: () => Promise<Response>) => {
  if (goneSet.size && goneSet.has(context.url.pathname)) {
    return new Response('Gone', { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return next();
};
