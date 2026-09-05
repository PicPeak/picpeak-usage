# Design notes

The portal follows the visual system of picpeak.app (its `DESIGN.md`, "Pic + Peak"
v2). Product mode: consistency over novelty, calm motion, dense but clear.

- **Tokens** (`web/style.css` `:root`): snow ground tinted toward fir, the logo green
  as primary, alpenglow as the single accent (in-progress chips, error notices, focus
  ring). Radii 3 px (inputs, chips) and 8 px (buttons, panels); bars are straight lines
  like the site's expiry bar.
- **Type**: Schibsted Grotesk 700 (display), Source Sans 3 400/600 (body), Spline Sans
  Mono 400 (labels, dates, numbers). Self-hosted in `public/fonts`, declared in
  `public/fonts.css`; no third-party requests.
- **Signature**: the three honest participation numbers in the overview hero, shown
  once a participant has entered the lookup hash. Nothing else is decorative. Raw
  packets render in the site's dark terminal block.
- **Motion**: page headings rise once on load; buttons transition 140 ms; a global
  `prefers-reduced-motion` kill switch. No scroll reveals.
- **Chrome**: header/footer mirror the site (mark + wordmark, underlined text links,
  one-row footer with license left and links right). Dates are shown as UTC days.

Contrast (checked): body 14.7:1, muted 6.5:1, button 8.3:1, accent as text 5.5:1.
