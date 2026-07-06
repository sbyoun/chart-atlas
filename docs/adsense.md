# AdSense Operations

This document records the current AdSense setup and rollout plan for Chart Atlas and related FoldAlpha subdomains.

## Current Status

- AdSense review site: `foldalpha.com`
- Canonical public app URL: `https://foldalpha.com/`
- Apex app route: `https://foldalpha.com/`
- WWW app route: `https://www.foldalpha.com/`
- `ads.txt` value:

```text
google.com, pub-1642219896856384, DIRECT, f08c47fec0942fa0
```

The same final `ads.txt` content is reachable from:

- `https://foldalpha.com/ads.txt`
- `https://www.foldalpha.com/ads.txt`
- `https://labs.foldalpha.com/ads.txt`

## June 28, 2026 Review Follow-up

AdSense sent a generic "site is not ready to show ads" review email. The exact reason must be checked in the AdSense `Sites` page before requesting another review.

Code and crawlability fixes applied after the rejection:

- Removed the global AdSense account script from the document `<head>` after the policy issue reported "Google-served ads on screens without publisher-content".
- Added meta description, canonical URL, Open Graph metadata, and `robots` meta tag to `index.html`.
- Added static fallback publisher content to `index.html` so basic content and policy links are visible before JavaScript renders.
- Added a Data and Methodology page with editorial explanation of chart snapshots, ranking signals, genre discovery, taste discovery, and limitations.
- Added `public/sitemap.xml` with the Chart Atlas home, about, privacy, contact, terms, and methodology URLs.
- Updated `public/robots.txt` to list the public information pages and point to `https://foldalpha.com/sitemap.xml`.
- Changed footer information items from button-only navigation to real links for crawler-visible access.
- Added real URL handling for `/about`, `/privacy`, `/contact`, `/terms`, and `/methodology`.
- Added `.xml` MIME handling in the local Node server.

AdSense console action before re-review:

- Turn off Auto ads until approval is granted.
- Do not enable `VITE_ENABLE_ADS` or manual ad slots before the low-value-content issue is resolved.
- After approval, enable ads only on content-rich pages first, not loading screens, empty states, playlist chat, or tool-only views.

Before requesting review again, verify:

```bash
curl -L https://foldalpha.com/ads.txt
curl -L https://foldalpha.com/robots.txt
curl -L https://foldalpha.com/sitemap.xml
curl -L https://foldalpha.com/privacy
curl -L https://foldalpha.com/contact
```

Also confirm the AdSense `Sites` page no longer reports missing code, navigation, privacy, or low-value-content issues.

## Cloudflare Routing

Cloudflare DNS routes the apex and `www` hostnames to `labs.foldalpha.com` through proxied CNAME records:

```text
CNAME foldalpha.com     -> labs.foldalpha.com
CNAME www.foldalpha.com -> labs.foldalpha.com
```

Cloudflare DNS routes the apex and `www` hostnames to this server. Redirect rules for the old apex-to-labs routing should remain disabled while Chart Atlas is served directly from the root domain.

Important security note: any temporary Cloudflare API token used for this setup should be deleted or rotated after use.

## Nginx Routing

The active nginx source template is:

```text
/home/ubuntu/foldalpha-site/deploy/nginx/foldalpha.com.conf
/home/ubuntu/fashion-youtube-archive/deploy/nginx/foldalpha-labs.conf
```

It is installed to:

```text
/etc/nginx/sites-available/foldalpha-labs
```

Current behavior:

- `https://foldalpha.com/` -> Chart Atlas
- `https://foldalpha.com/music/` -> `https://foldalpha.com/`
- `https://labs.foldalpha.com/` -> `https://foldalpha.com/`
- `https://labs.foldalpha.com/music/` -> `https://foldalpha.com/`
- `https://labs.foldalpha.com/ads.txt` -> Chart Atlas public `ads.txt`
- `https://labs.foldalpha.com/robots.txt` -> Chart Atlas public `robots.txt`
- `https://labs.foldalpha.com/privacy` -> `https://foldalpha.com/privacy`
- `https://labs.foldalpha.com/fashion/` remains available for Fashion YouTube Archive

## Chart Atlas Files

AdSense-related files live in:

```text
/home/ubuntu/chart-atlas/public/ads.txt
/home/ubuntu/chart-atlas/public/robots.txt
/home/ubuntu/chart-atlas/src/AdSlot.tsx
```

The production build copies `public/ads.txt` and `public/robots.txt` into `dist/`.

Build and verify after edits:

```bash
npm run build
npm run lint
sudo systemctl restart chart-atlas.service
```

Check public output:

```bash
curl -L https://foldalpha.com/ads.txt
curl -L https://www.foldalpha.com/ads.txt
curl -L https://labs.foldalpha.com/ads.txt
curl -L https://foldalpha.com
```

## Consent Message

AdSense consent message choice:

```text
Google CMP with 3 choices:
Consent, Do not consent, Manage options
```

This is intended for EEA, UK, and Switzerland consent requirements. Keep this enabled before serving ads.

## Rollout Plan

Do not enable broad ads before the initial AdSense site review is approved.

Recommended rollout:

1. Wait for `foldalpha.com` AdSense approval.
2. Enable ads only in Chart Atlas.
3. Confirm ads serve normally and no policy issue appears.
4. Expand to `labs.foldalpha.com/fashion/` only after Chart Atlas is stable.
5. Expand to `lunch.foldalpha.com` public web/PWA pages only after Fashion is stable.
6. Use AdMob, not AdSense, for native iOS/Android app ads.

## Enabling Chart Atlas Ads

The current frontend reads these environment variables:

```text
VITE_ENABLE_ADS
VITE_ADSENSE_CLIENT
VITE_AD_SLOT_HEADER
VITE_AD_SLOT_CHART_FOOTER
VITE_AD_SLOT_GENRE_SIDEBAR
```

After approval, set:

```text
VITE_ENABLE_ADS=true
VITE_ADSENSE_CLIENT=ca-pub-1642219896856384
```

Then add real ad slot IDs from AdSense and rebuild/restart.

## Fashion Subdomain

`labs.foldalpha.com/fashion/` can use AdSense after `foldalpha.com` is approved because it is a subdomain of the approved root domain.

Before adding ads to Fashion:

- Remove `Disallow: /fashion/` from `public/robots.txt`.
- Add a visible privacy link or footer if missing.
- Add AdSense code conservatively, starting with one placement.
- Keep Fashion ads separate from Chart Atlas rollout verification.

## Lunch Subdomain

`lunch.foldalpha.com` web/PWA pages can use AdSense after `foldalpha.com` is approved.

Use AdSense only on public web surfaces such as:

- Landing page
- Intro/support pages
- Public games or content pages

Avoid ads in sensitive or logged-in flows:

- Matching screens
- Chat
- Profile/location verification
- Admin pages
- Any screen with private company/user data

## Native Apps

Native iOS/Android app ads should use AdMob, not AdSense.

For AdMob, publish `app-ads.txt` at the root of the developer website listed in the app stores. If the developer website is `https://lunch.foldalpha.com`, then AdMob expects:

```text
https://lunch.foldalpha.com/app-ads.txt
```

The expected content usually uses the same publisher line format:

```text
google.com, pub-1642219896856384, DIRECT, f08c47fec0942fa0
```

Confirm the exact publisher ID in the AdMob console before publishing.

## Notes

- AdSense now manages sites at the root-domain level; subdomains are not separately added as sites.
- `ads.txt` and `app-ads.txt` are separate files for web and app inventory.
- Keep ad rollout incremental. If a policy issue appears, isolate it to the most recently enabled surface.
