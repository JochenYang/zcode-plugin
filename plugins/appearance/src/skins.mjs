// Colour skins. ZCode paints with `--color-*` custom properties (345 of them in the shipped
// stylesheet); a skin replaces the handful the surfaces, the text, the borders and the accent
// read from, once per light and dark theme, and the rest keeps deriving from those.
//
// Five colours per mode: base (the window), surface (cards, panels, popovers), text, accent
// (links, the primary action) and border. A preset is data only; `skinCss` turns it into rules.

export const SKINS = Object.freeze({
  default: null,
  midnight: Object.freeze({
    light: Object.freeze({ base: '#eef1f6', surface: '#ffffff', text: '#16202e', accent: '#2563eb', border: '#d5dbe5' }),
    dark: Object.freeze({ base: '#0b1120', surface: '#121a2e', text: '#e5e9f2', accent: '#60a5fa', border: '#243044' }),
  }),
  sepia: Object.freeze({
    light: Object.freeze({ base: '#f4ead8', surface: '#fbf4e6', text: '#3b2f22', accent: '#a16207', border: '#dccfb6' }),
    dark: Object.freeze({ base: '#1c1611', surface: '#261f18', text: '#efe4d2', accent: '#d6a756', border: '#3a3026' }),
  }),
});

export const SKIN_NAMES = Object.freeze(Object.keys(SKINS));

// The colours to use for each mode, or null when the app should keep its own.
export function resolveSkin(config) {
  if (config.skin.preset !== 'default') return SKINS[config.skin.preset];
  if (config.skin.custom) return config.skin.custom;
  return null;
}
