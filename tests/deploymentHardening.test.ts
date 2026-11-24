import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { spawn } from 'node:child_process';

process.env.CIVIFIX_NO_LISTEN = '1';

const ROOT_DIR = process.cwd();
const BUILTIN_SET = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

function extractExternalImports(bundleSource: string): string[] {
  const pkgs = new Set<string>();
  const staticImportRe = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImportRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const re of [staticImportRe, dynamicImportRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(bundleSource)) !== null) {
      const spec = match[1];
      if (!spec || spec.startsWith('.') || spec.startsWith('/') || BUILTIN_SET.has(spec)) {
        continue;
      }
      const pkgName = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : spec.split('/')[0];
      pkgs.add(pkgName);
    }
  }
  return Array.from(pkgs).sort();
}

async function runTests() {
  process.env.CIVIFIX_NO_LISTEN = '1';
  const {
    normalizeConfiguredOrigin,
    buildAllowedOrigins,
    isOriginAllowed,
  } = await import('../server');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${err?.message || err}`);
      failed++;
    }
  }

  console.log('\n======================================================');
  console.log('  CIVIFIX AI — DEPLOYMENT HARDENING REGRESSION SUITE');
  console.log('======================================================\n');

  await test('1. normalizeConfiguredOrigin trims whitespace, strips trailing slashes, and rejects wildcards/paths', () => {
    assert.equal(normalizeConfiguredOrigin('https://civifix.city.gov'), 'https://civifix.city.gov');
    assert.equal(normalizeConfiguredOrigin('https://civifix.city.gov/'), 'https://civifix.city.gov');
    assert.equal(
      normalizeConfiguredOrigin('  HTTPS://CiviFix.City.Gov///  '),
      'https://civifix.city.gov'
    );
    assert.equal(
      normalizeConfiguredOrigin('https://portal.city.gov:8443/'),
      'https://portal.city.gov:8443'
    );

    assert.equal(normalizeConfiguredOrigin('*'), null);
    assert.equal(normalizeConfiguredOrigin('https://*.city.gov'), null);
    assert.equal(normalizeConfiguredOrigin('https://civifix.city.gov/app'), null);
    assert.equal(normalizeConfiguredOrigin('https://user:pass@civifix.city.gov'), null);
    assert.equal(normalizeConfiguredOrigin('javascript:alert(1)'), null);
    assert.equal(normalizeConfiguredOrigin(''), null);
  });

  await test('2. Custom domain with and without trailing slash in APP_URL is allowed accurately', () => {
    const withSlash = buildAllowedOrigins({ APP_URL: ' https://civifix.example.org/ ' });
    const withoutSlash = buildAllowedOrigins({ APP_URL: 'https://civifix.example.org' });

    assert.equal(isOriginAllowed('https://civifix.example.org', withSlash), true);
    assert.equal(isOriginAllowed('https://civifix.example.org', withoutSlash), true);

    // Exact match only: spoofed prefix/suffix/subdomain or http downgrade must be rejected
    assert.equal(isOriginAllowed('https://civifix.example.org.evil.com', withSlash), false);
    assert.equal(isOriginAllowed('https://evil.civifix.example.org', withSlash), false);
    assert.equal(isOriginAllowed('http://civifix.example.org', withSlash), false);
    assert.equal(isOriginAllowed('https://civifix.example.org/', withSlash), false);
  });

  await test('3. Multiple ALLOWED_ORIGINS plus APP_URL are parsed cleanly and compared exactly', () => {
    const allowed = buildAllowedOrigins({
      APP_URL: 'https://main.civifix.org/',
      ALLOWED_ORIGINS:
        ' https://portal.civifix.org/ , https://admin.civifix.org , , *, https://m.civifix.org/// ',
    });

    assert.equal(allowed.size, 4);
    assert.equal(isOriginAllowed('https://main.civifix.org', allowed), true);
    assert.equal(isOriginAllowed('https://portal.civifix.org', allowed), true);
    assert.equal(isOriginAllowed('https://admin.civifix.org', allowed), true);
    assert.equal(isOriginAllowed('https://m.civifix.org', allowed), true);
    assert.equal(isOriginAllowed('https://unlisted.civifix.org', allowed), false);
    assert.equal(isOriginAllowed('*', allowed), false);
  });

  await test('4. Existing Cloud Run, Firebase Hosting, AI Studio, and localhost origins remain allowed', () => {
    const empty = buildAllowedOrigins({});

    assert.equal(
      isOriginAllowed('https://ais-dev-test-123.asia-southeast1.run.app', empty),
      true
    );
    assert.equal(isOriginAllowed('https://civifix-ai-214ec.web.app', empty), true);
    assert.equal(isOriginAllowed('https://civifix-ai-214ec.firebaseapp.com', empty), true);
    assert.equal(isOriginAllowed('https://preview.aistudio.google.com', empty), true);
    assert.equal(isOriginAllowed('https://app-123.googleusercontent.com', empty), true);
    assert.equal(isOriginAllowed('https://localhost', empty), true);
    assert.equal(isOriginAllowed('http://localhost:3000', empty), true);
    assert.equal(isOriginAllowed('http://127.0.0.1:5173', empty), true);
    assert.equal(isOriginAllowed(undefined, empty), true);
  });

  await test('5. Unapproved origins and host-spoofing attempts are strictly rejected', () => {
    const empty = buildAllowedOrigins({});

    assert.equal(isOriginAllowed('https://attacker.example.com', empty), false);
    assert.equal(isOriginAllowed('http://civifix-ai-214ec.web.app', empty), false);
    assert.equal(isOriginAllowed('http://service.run.app', empty), false);
    assert.equal(isOriginAllowed('https://service.run.app.evil.com', empty), false);
    assert.equal(isOriginAllowed('https://evilrun.app', empty), false);
    assert.equal(isOriginAllowed('https://evil.com@civifix-ai-214ec.web.app', empty), false);
    assert.equal(isOriginAllowed('http://localhost:3000.evil.com', empty), false);
    assert.equal(isOriginAllowed('http://127.0.0.1:3000.evil.com', empty), false);
    assert.equal(isOriginAllowed('null', empty), false);
    assert.equal(isOriginAllowed('*', empty), false);
  });

  await test('6. package.json start script and compiled dist/server.mjs require zero devDependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.start, 'node dist/server.mjs');
    assert.ok(
      !pkg.scripts.start.includes('tsx'),
      'Production start script must not depend on tsx in devDependencies'
    );

    const serverBundlePath = path.join(ROOT_DIR, 'dist', 'server.mjs');
    assert.ok(
      fs.existsSync(serverBundlePath),
      'dist/server.mjs must exist after running npm run build'
    );

    const bundleSource = fs.readFileSync(serverBundlePath, 'utf8');
    const externalPkgs = extractExternalImports(bundleSource);
    const prodDeps = new Set(Object.keys(pkg.dependencies || {}));
    const devDeps = new Set(Object.keys(pkg.devDependencies || {}));

    for (const dep of externalPkgs) {
      assert.ok(
        prodDeps.has(dep),
        `Compiled dist/server.mjs imports "${dep}" which must be listed in dependencies (not only devDependencies)`
      );
      assert.ok(
        !devDeps.has(dep),
        `Compiled dist/server.mjs must not rely on devDependency "${dep}"`
      );
    }
  });

  await test('7. Real production startup smoke test via node dist/server.mjs verifies SPA, health, and CORS enforcement', async () => {
    const testPort = 3217;
    const baseUrl = `http://127.0.0.1:${testPort}`;

    const child = spawn(process.execPath, ['dist/server.mjs'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        CIVIFIX_NO_LISTEN: '0',
        NODE_ENV: 'production',
        PORT: String(testPort),
        APP_URL: 'https://civic.custom-city.gov/',
        ALLOWED_ORIGINS: ' https://portal.custom-city.gov/ , https://admin.custom-city.gov ',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let logs = '';
    child.stdout?.on('data', (d) => (logs += d.toString()));
    child.stderr?.on('data', (d) => (logs += d.toString()));

    try {
      let ready = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 150));
        try {
          const res = await fetch(`${baseUrl}/api/health`);
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          // Server still starting
        }
      }
      assert.ok(ready, `Production server failed to boot on port ${testPort}. Logs: ${logs}`);

      // 1. Health endpoint in production mode
      const healthRes = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200);
      const healthJson: any = await healthRes.json();
      assert.equal(healthJson.status, 'healthy');
      assert.equal(healthJson.environment, 'production');

      // 2. Built SPA served from dist/index.html
      const spaRes = await fetch(`${baseUrl}/`);
      assert.equal(spaRes.status, 200);
      assert.ok(
        (spaRes.headers.get('content-type') || '').includes('text/html'),
        'Root route must serve built HTML in production'
      );

      // 3. Configured APP_URL with trailing slash normalized -> passes CORS and hits auth guard (401)
      const customAppRes = await fetch(`${baseUrl}/api/groq/validate-civic-image`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://civic.custom-city.gov',
        },
        body: JSON.stringify({ photoBase64: '' }),
      });
      assert.equal(customAppRes.status, 401);
      assert.equal(
        customAppRes.headers.get('access-control-allow-origin'),
        'https://civic.custom-city.gov'
      );

      // 4. Configured ALLOWED_ORIGINS entry with trailing slash normalized -> passes CORS
      const allowedListRes = await fetch(`${baseUrl}/api/groq/validate-civic-image`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://portal.custom-city.gov',
        },
        body: JSON.stringify({ photoBase64: '' }),
      });
      assert.equal(allowedListRes.status, 401);
      assert.equal(
        allowedListRes.headers.get('access-control-allow-origin'),
        'https://portal.custom-city.gov'
      );

      // 5. Existing Cloud Run origin -> passes CORS
      const cloudRunRes = await fetch(`${baseUrl}/api/groq/validate-civic-image`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://civifix-prod.asia-southeast1.run.app',
        },
        body: JSON.stringify({ photoBase64: '' }),
      });
      assert.equal(cloudRunRes.status, 401);
      assert.equal(
        cloudRunRes.headers.get('access-control-allow-origin'),
        'https://civifix-prod.asia-southeast1.run.app'
      );

      // 6. Unapproved origin -> rejected cleanly with 403 and NO Access-Control-Allow-Origin header
      const blockedRes = await fetch(`${baseUrl}/api/groq/validate-civic-image`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil-unapproved.example.com',
        },
        body: JSON.stringify({ photoBase64: '' }),
      });
      assert.equal(blockedRes.status, 403);
      assert.equal(blockedRes.headers.get('access-control-allow-origin'), null);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 250));
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }
  });

  console.log('\n======================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Deployment hardening test runner crashed:', err);
  process.exit(1);
});
