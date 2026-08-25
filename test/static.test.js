/**
 * Static wiring audit. Catches the class of bug that unit tests miss entirely:
 * markup referencing a CSS class or element id that does not exist, or a screen
 * nothing can navigate to.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const js  = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
const htm = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

// HTML attribute values that look like classes but are not.
const NOT_CLASSES = new Set(['disabled', 'checked', 'selected', 'hidden', 'true', 'false']);

describe('client wiring', () => {
  test('every CSS class used in markup is defined', () => {
    const used = new Set();
    for (const src of [js, htm])
      for (const m of src.matchAll(/class="([^"]*)"/g))
        for (const tok of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/))
          if (tok && /^[a-z][a-z0-9-]*$/i.test(tok)) used.add(tok);
    // classes produced inside template ternaries, e.g. ${sel ? 'pick' : ''}
    for (const m of js.matchAll(/class="[^"]*\$\{[^}]*?'([a-z][a-z0-9-]{1,})'[^}]*?\}[^"]*"/g)) used.add(m[1]);

    // Interpolated class names (class="seg seg-${k}", class="avatar v${n}") would
    // otherwise slip through as a harmless-looking stem. Expand them against the
    // values the code can actually produce, so a missing variant is caught.
    for (const [, stem] of js.matchAll(/class="[^"]*\b([a-z][a-z0-9-]*-?)\$\{/g)) {
      const re = new RegExp(`\\.${stem.replace(/-$/, '-')}[a-z0-9-]+`, 'i');
      assert.ok(re.test(css), `no CSS variant defined for interpolated class "${stem}\${...}"`);
      used.delete(stem);
    }
    for (const n of [1, 2, 3]) used.add('v' + n);        // avatar tints
    for (const k of ['wallet', 'hold', 'empty']) used.add('seg-' + k);

    const defined = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map(m => m[1]));
    const missing = [...used].filter(c => !defined.has(c) && !NOT_CLASSES.has(c)).sort();
    assert.deepEqual(missing, [], `undefined CSS classes: ${missing.join(', ')}`);
  });

  test('every element id the script reaches for exists somewhere', () => {
    const htmlIds = new Set([...htm.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
    const runtime = new Set([...js.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
    const wanted  = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));
    const orphan  = [...wanted].filter(i => !htmlIds.has(i) && !runtime.has(i));
    assert.deepEqual(orphan, [], `script reads ids that are never rendered: ${orphan.join(', ')}`);
  });

  test('every screen is reachable', () => {
    const screens = new Set([...js.matchAll(/^V\.([a-zA-Z]+)/gm)].map(m => m[1]));
    const reach = new Set([
      ...[...js.matchAll(/go\('([a-zA-Z]+)'\)/g)].map(m => m[1]),
      ...[...js.matchAll(/screen:\s*'([a-zA-Z]+)'/g)].map(m => m[1]),
      ...[...js.matchAll(/S\.screen\s*=\s*'([a-zA-Z]+)'/g)].map(m => m[1]),
      ...[...js.matchAll(/\['([a-z]+)',\s*'[A-Z]/g)].map(m => m[1]),
      ...[...js.matchAll(/V\.([a-zA-Z]+)\)/g)].map(m => m[1]),
    ]);
    const stranded = [...screens].filter(s => !reach.has(s));
    assert.deepEqual(stranded, [], `no navigation path to: ${stranded.join(', ')}`);
  });

  test('the client never hardcodes a key or a connector', () => {
    assert.ok(!/sk_|snd_[a-z0-9]{6,}/.test(js), 'a secret-looking key is embedded in the client');
    assert.ok(!/"connector"\s*:|merchant_connector_id/.test(js), 'the client must not choose a processor');
  });

  test('card fields are never rendered by us', () => {
    assert.ok(!/card_number|cardNumber|autocomplete="cc-/i.test(js),
      'card inputs in our DOM would put the app in PCI scope');
    assert.ok(/HyperLoader\.js/.test(htm), 'the Hyperswitch SDK must be loaded');
  });
});
