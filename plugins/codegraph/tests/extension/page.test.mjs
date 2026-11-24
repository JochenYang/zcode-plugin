// The storage view (ui/index.html) in a real browser engine, the way ZCode embeds it: the page
// as shipped, with page-host.js standing in for the host. Every answer comes from the real
// `viewData` (page-fixture.mjs), so the page is held to the shape the extension really sends.
//
// Without a browser the cases are skipped and say so (page-harness.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, skip } from './page-harness.mjs';
import { runFor } from './page-fixture.mjs';
import { viewStrings } from '../../src/extension/describe.mjs';

const options = { skip };
const DESKTOP = { width: 1280, height: 900 };
const NARROW = { width: 320, height: 900 };

test('in Chinese on a desktop window: the light theme, then the dark one', options, () => {
  const { failures, metrics } = open(runFor('zh-CN', 'zh-CN'), DESKTOP);
  assert.deepEqual(failures, [], JSON.stringify(metrics));
});

test('in Chinese at 320 pixels wide', options, () => {
  const { failures, metrics } = open(runFor('zh-CN', 'zh-CN'), NARROW);
  assert.deepEqual(failures, [], JSON.stringify(metrics));
  assert.equal(metrics.viewport, 320, 'the window is as narrow as asked');
});

test('in English, starting from the dark theme', options, () => {
  const { failures, metrics } = open(runFor('en-US', 'en', 'dark'), DESKTOP);
  assert.deepEqual(failures, [], JSON.stringify(metrics));
});

test('opened outside ZCode: the view says so and offers to try again', options, () => {
  // Without the host the page cannot know the language and takes the browser's.
  const said = [
    `${viewStrings('zh-CN').failed('')}这个页面要在 ZCode 里面打开。`,
    `${viewStrings('en-US').failed('')}This page runs inside ZCode.`,
  ];
  const run = { withoutHost: true, theme: 'light', locale: 'en-US', lang: 'en', expect: { noHost: said } };
  const { failures } = open(run, DESKTOP);
  assert.deepEqual(failures, []);
});
