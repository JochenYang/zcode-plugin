// Colour skins. ZCode paints with `--color-*` custom properties (345 of them in the shipped
// stylesheet); a skin replaces the handful the surfaces, the text, the borders and the accent
// read from, once per light and dark theme, and the rest keeps deriving from those.
//
// Five colours per mode: base (the window), surface (cards, panels, popovers), text, accent
// (links, the primary action) and border. A preset is data only; `skinCss` turns it into rules.
//
// Each preset takes its colours from a scheme people already work in every day, the ones the
// community keeps at the top of its lists (Catppuccin, Kanagawa, Ayu, One Dark, Nightfox, Rosé
// Pine, Gruvbox, and the palettes of Twitch, Discord and GitHub), so it reads as "that look"
// rather than as five colours put together. Where a scheme's own accent or text would fall
// below 4.5:1 against ZCode's surfaces, the nearest shade of the same hue is taken instead.
// tests/skins.test.mjs measures every preset: text and the accent at 4.5:1 or better on the base
// and the surface in both themes, the border visible against the base.

export const SKINS = Object.freeze({
  default: null,
  // Catppuccin: Latte for the light theme (cards a shade lighter, the mauve as the accent),
  // Mocha for the dark one.
  catppuccin: Object.freeze({
    light: Object.freeze({ base: '#eff1f5', surface: '#f4f5f9', text: '#4c4f69', accent: '#8839ef', border: '#ccd0da' }),
    dark: Object.freeze({ base: '#1e1e2e', surface: '#181825', text: '#cdd6f4', accent: '#89b4fa', border: '#45475a' }),
  }),
  // Kanagawa: Lotus and Wave, from the palette of the Hokusai-inspired theme.
  kanagawa: Object.freeze({
    light: Object.freeze({ base: '#f2ecbc', surface: '#e5ddb0', text: '#545464', accent: '#3f5f93', border: '#dcd5ac' }),
    dark: Object.freeze({ base: '#1f1f28', surface: '#2a2a37', text: '#dcd7ba', accent: '#7e9cd8', border: '#363646' }),
  }),
  // Ayu: its light and dark variants; the accent is the orange the theme puts on buttons, in
  // the shade it uses for text on them in the light theme.
  ayu: Object.freeze({
    light: Object.freeze({ base: '#fcfcfc', surface: '#f3f4f6', text: '#5c6b81', accent: '#7e4b01', border: '#dfe3e8' }),
    dark: Object.freeze({ base: '#10141c', surface: '#141821', text: '#bfbdb6', accent: '#e6b450', border: '#272d38' }),
  }),
  // Atom's One Light and One Dark Pro, the most-installed editor theme; the blue, one step
  // darker in the light theme.
  'one-dark': Object.freeze({
    light: Object.freeze({ base: '#fafafa', surface: '#ffffff', text: '#383a42', accent: '#2e6ad1', border: '#d8d8da' }),
    dark: Object.freeze({ base: '#282c34', surface: '#2c313a', text: '#abb2bf', accent: '#61afef', border: '#3e4451' }),
  }),
  // Nightfox: Dayfox for the light theme.
  nightfox: Object.freeze({
    light: Object.freeze({ base: '#eaeaea', surface: '#d6d6d6', text: '#1c1e26', accent: '#2848a9', border: '#c5c5c5' }),
    dark: Object.freeze({ base: '#192330', surface: '#212e3f', text: '#cdcecf', accent: '#719cd6', border: '#2b3b51' }),
  }),
  // Discord: its greys and its blues, the darker blurple on white.
  discord: Object.freeze({
    light: Object.freeze({ base: '#ffffff', surface: '#f2f3f5', text: '#4e5058', accent: '#4752c4', border: '#e3e5e8' }),
    dark: Object.freeze({ base: '#313338', surface: '#383a40', text: '#dbdee1', accent: '#3fb9fc', border: '#3f4147' }),
  }),
  // Rosé Pine Dawn (light) and Rosé Pine (dark), with its "love" as the accent.
  sakura: Object.freeze({
    light: Object.freeze({ base: '#faf4ed', surface: '#f2e9e1', text: '#575279', accent: '#9d4862', border: '#dfdad9' }),
    dark: Object.freeze({ base: '#191724', surface: '#1f1d2e', text: '#e0def4', accent: '#eb6f92', border: '#2c2944' }),
  }),
  // Gruvbox, both ways, with its orange.
  amber: Object.freeze({
    light: Object.freeze({ base: '#fbf1c7', surface: '#ebdbb2', text: '#3c3836', accent: '#a63703', border: '#d5c4a1' }),
    dark: Object.freeze({ base: '#282828', surface: '#3c3836', text: '#ebdbb2', accent: '#fe8019', border: '#665c54' }),
  }),
  // Twitch: its dark greys and its purple, the lighter purple on the dark theme.
  plum: Object.freeze({
    light: Object.freeze({ base: '#f7f7f8', surface: '#ffffff', text: '#0e0e10', accent: '#772ce8', border: '#dedee3' }),
    dark: Object.freeze({ base: '#18181b', surface: '#1f1f23', text: '#efeff1', accent: '#bf94ff', border: '#3a3a3d' }),
  }),
  // GitHub, light and dark: neutral greys and the one blue.
  graphite: Object.freeze({
    light: Object.freeze({ base: '#ffffff', surface: '#f6f8fa', text: '#1f2328', accent: '#0969da', border: '#d0d7de' }),
    dark: Object.freeze({ base: '#0d1117', surface: '#161b22', text: '#e6edf3', accent: '#58a6ff', border: '#30363d' }),
  }),
});

// The names a preset card stands for. `custom` is one of them: the colours of `skin.custom`,
// kept whatever the preset is, and shown only while it is the preset.
export const CUSTOM_SKIN = 'custom';
export const SKIN_NAMES = Object.freeze(Object.keys(SKINS));
export const SKIN_PRESETS = Object.freeze([...SKIN_NAMES, CUSTOM_SKIN]);

// The colours to use for each mode, or null when the app should keep its own.
export function resolveSkin(config) {
  const { preset, custom } = config.skin;
  if (preset === CUSTOM_SKIN) return custom ?? null;
  if (preset !== 'default') return SKINS[preset] ?? null;
  return null;
}
