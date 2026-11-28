'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-patch-'));
const scriptsDir = path.join(tmp, 'scripts');
const patchesDir = path.join(tmp, 'patches');
const targetDir = path.join(tmp, 'node_modules', 'fake-pkg', 'src');
const targetPath = path.join(targetDir, 'file.js');

fs.mkdirSync(scriptsDir, { recursive: true });
fs.mkdirSync(patchesDir, { recursive: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(path.join(root, 'scripts', 'apply-patches.js'), path.join(scriptsDir, 'apply-patches.js'));
fs.writeFileSync(targetPath, `${Array.from({ length: 19 }, (_, index) => `const before${index} = ${index};`).join('\n')}\nconst oldValue = true;\nconst keep = 1;\n`);
fs.writeFileSync(path.join(patchesDir, 'fake-pkg+1.0.0.patch'), `diff --git a/src/file.js b/src/file.js
--- a/src/file.js
+++ b/src/file.js
@@ -1,2 +1,2 @@
-const oldValue = true;
+const newValue = true;
 const keep = 1;
`);

const run = () => execFileSync(process.execPath, [path.join(scriptsDir, 'apply-patches.js')], { cwd: tmp, encoding: 'utf8' });
run();
const applied = fs.readFileSync(targetPath, 'utf8');
assert.ok(applied.includes('const before0 = 0;'));
assert.ok(applied.includes('const newValue = true;'));
assert.ok(applied.includes('const keep = 1;'));
assert.ok(!applied.includes('const oldValue = true;'));
run();
assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), applied);
console.log('ok - patches: contexto deslocado e reaplicacao idempotente');
