#!/usr/bin/env node
// Entry point of the launcher. Diagnostics go to stderr; stdout carries only --status output.
import { ConfigError } from '../src/config.mjs';
import { LauncherError, notify, run } from '../src/launcher.mjs';

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    const message = err instanceof LauncherError || err instanceof ConfigError ? err.message : (err?.stack ?? String(err));
    process.stderr.write(`zcode-appearance: ${message}\n`);
    // Started from the .cmd wrapper there is no console to read this from.
    if (process.env.ZCODE_APPEARANCE_NO_CONSOLE === '1') notify(message);
    process.exitCode = 2;
  });
