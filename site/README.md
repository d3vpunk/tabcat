# tabcat website

Static Astro landing page. Independent of the CLI build; no analytics or external fonts.
The website build requires Node.js >= 22.19.0; the CLI's requirements are unchanged.

```sh
cd site
npm install
npm run dev
npm run build
npm run preview
```

The logo is imported from the repository root so there is only one source asset.
The terminal is an illustrative, manually stepped demo, not a live shell.

Before publishing, set `SITE_URL` to the public origin. For GitHub project Pages,
also set `BASE_PATH` to `/tabcat/`. A canonical URL, social image URL and sitemap
are generated when `SITE_URL` is supplied. No deployment is configured yet.

```sh
SITE_URL=https://example.com npm run build
```
