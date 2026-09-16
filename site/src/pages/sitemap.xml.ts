import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const url = site ? new URL(import.meta.env.BASE_URL, site).href : null;
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${url ? `<url><loc>${url.replaceAll('&', '&amp;')}</loc></url>` : ''}</urlset>`,
    { headers: { 'Content-Type': 'application/xml' } },
  );
};
