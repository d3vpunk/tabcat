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

## Deployment

GitHub Actions publishes the site to https://d3vpunk.github.io/tabcat/ when
changes to `site/`, the root logo or the deployment workflow reach `main`.
The workflow can also be run manually from the Actions tab. Repository Pages
settings must use **GitHub Actions** as the build source.

The workflow obtains `SITE_URL` and `BASE_PATH` from GitHub Pages configuration,
so asset paths, canonical URLs and the sitemap follow the configured site URL.
The CLI and npm release process are independent of this deployment.

To reproduce the project Pages build locally:

```sh
SITE_URL=https://d3vpunk.github.io BASE_PATH=/tabcat/ npm run build
```
