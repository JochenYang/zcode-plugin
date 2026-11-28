// Every preset is measured, not judged by eye: text and the accent (it is read as link text) at
// 4.5:1 or better on the base and on the surface in both themes, the border visible against the
// base, and five colours in each set.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SKINS, SKIN_PRESETS, resolveSkin } from '../src/skins.mjs';
import { defaultConfig, applyPatch } from '../src/config.mjs';

const KEYS = ['base', 'surface', 'text', 'accent', 'border'];
const HEX = /^#[0-9a-f]{6}$/i;

// WCAG relative luminance and contrast ratio. #RRGGBB: the channels start at 1, 3 and 5.
const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16) / 255;
const luminance = (hex) => [1, 3, 5]
  .map((at) => channel(hex, at))
  .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

describe('colour skins', () => {
  it('has the presets, each in five colours per theme', () => {
    assert.equal(SKINS.default, null, '"default" is the app\'s own colours');
    for (const name of SKIN_PRESETS.filter((preset) => preset !== 'default' && preset !== 'custom')) {
      const skin = SKINS[name];
      for (const mode of ['light', 'dark']) {
        assert.deepEqual(Object.keys(skin[mode]).sort(), [...KEYS].sort(), `${name}.${mode}`);
        for (const value of Object.values(skin[mode])) assert.match(value, HEX, `${name}.${mode}: ${value}`);
      }
    }
  });

  it('keeps text and the accent readable on the base and the surface, and the border visible', () => {
    const report = [];
    for (const [name, skin] of Object.entries(SKINS)) {
      if (!skin) continue;
      for (const mode of ['light', 'dark']) {
        const { base, surface, text, accent, border } = skin[mode];
        for (const [role, ink, on] of [['text', text, base], ['text', text, surface], ['accent', accent, base], ['accent', accent, surface]]) {
          const ratio = contrast(ink, on);
          assert.ok(ratio >= 4.5, `${name}.${mode}: ${role} on ${on === base ? 'base' : 'surface'} is ${ratio.toFixed(2)}:1`);
          report.push(`${name}.${mode} ${role}/${on === base ? 'base' : 'surface'} ${ratio.toFixed(1)}`);
        }
        assert.ok(contrast(border, base) >= 1.2, `${name}.${mode}: the border is not visible on the base (${contrast(border, base).toFixed(2)}:1)`);
        // The surface stands a little apart from the base, or cards disappear into it.
        assert.ok(contrast(surface, base) >= 1.03, `${name}.${mode}: the surface is the base`);
      }
    }
    assert.ok(report.length >= 8 * 4);
  });

  it('is light in the light theme and dark in the dark one', () => {
    for (const [name, skin] of Object.entries(SKINS)) {
      if (!skin) continue;
      assert.ok(luminance(skin.light.base) > 0.6, `${name}: the light base is not light`);
      // Kanagawa's and One Dark's dark backgrounds sit just above 0.03; deeper than that is night.
      assert.ok(luminance(skin.dark.base) < 0.04, `${name}: the dark base is not dark`);
    }
  });

  it('uses the custom colours only while "custom" is the preset, and keeps them otherwise', () => {
    const custom = { dark: { base: '#101418', surface: '#181d25', text: '#e6e6e6', accent: '#38bdf8', border: '#2a303a' } };
    let config = applyPatch(defaultConfig(), { customSkin: custom });
    assert.equal(config.skin.preset, 'custom', 'giving a custom skin makes it the preset');
    assert.deepEqual(resolveSkin(config), custom);
    // Choosing "default" is the app's own colours again; the custom ones wait.
    config = applyPatch(config, { skin: 'default' });
    assert.equal(resolveSkin(config), null);
    assert.deepEqual(config.skin.custom, custom, 'kept');
    assert.equal(applyPatch(config, { skin: 'custom' }).skin.preset, 'custom');
    // A preset card applies that preset, whatever the custom skin holds.
    config = applyPatch(config, { skin: 'ayu' });
    assert.deepEqual(resolveSkin(config), SKINS.ayu);
    assert.deepEqual(config.skin.custom, custom);
    // Clearing the custom skin while it is the preset goes back to the app's colours.
    config = applyPatch(applyPatch(defaultConfig(), { customSkin: custom }), { customSkin: null });
    assert.equal(config.skin.preset, 'default');
    assert.throws(() => applyPatch(defaultConfig(), { skin: 'custom' }), /skin\.preset custom needs skin\.custom/);
  });
});
