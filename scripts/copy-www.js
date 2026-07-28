'use strict';

/**
 * copy-www.js
 * ------------------------------------------------------------------------
 * Kopiuje pliki gry (index.html, style.css, js/, assets/) do www/ - folderu
 * wskazanego jako webDir w capacitor.config.json. Capacitor kopiuje
 * ZAWARTOŚĆ webDir do natywnej apki przy `cap sync` - webDir wskazuje na
 * www/ (nie na korzeń projektu), żeby nie wciągać tam node_modules/,
 * package.json, .git itp.
 *
 * Bez żadnych zależności npm - sam Node - żeby ten JEDEN skrypt nie
 * wymagał niczego więcej niż to, co i tak trzeba mieć zainstalowane.
 * Wołany przez `npm run prepare-www` (patrz package.json).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const ITEMS_TO_COPY = ['index.html', 'style.css', 'js', 'assets'];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

for (const item of ITEMS_TO_COPY) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) {
    copyRecursive(src, path.join(WWW, item));
    console.log(`[copy-www] Skopiowano: ${item}`);
  } else {
    console.warn(`[copy-www] Pominięte (nie istnieje): ${item}`);
  }
}

console.log('[copy-www] Gotowe - www/ zaktualizowane.');
