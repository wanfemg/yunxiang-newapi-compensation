import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bashAvailable, deployFixture, toShell } from './deploy-fixture.mjs';

for (const mode of ['remote', 'local']) {
  test(`${mode} installation into an empty directory includes the legacy deployment script required by image tests`, { skip: !bashAvailable }, () => {
    const fixture = deployFixture();
    try {
      const target = join(fixture.base, 'clean-install');
      const bootstrap = mode === 'remote'
        ? fixture.remote()
        : { script: join(fixture.directory, 'install.sh'), env: {} };
      assert.equal(existsSync(target), false);
      const installed = fixture.run('install.sh', ['--install', '--non-interactive'], {
        ...bootstrap.env, YUNXIANG_INSTALL_DIR: toShell(target)
      }, { script: bootstrap.script, cwd: fixture.base });
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);

      // Run the exact failing image tests from the installed artifact, not the checkout.
      const environment = { ...process.env };
      delete environment.NODE_TEST_CONTEXT;
      const verification = spawnSync(process.execPath, ['--test', 'test/legacy-db-discovery.test.mjs'], {
        cwd: target, env: environment, encoding: 'utf8', timeout: 20000
      });
      assert.equal(verification.status, 0, verification.stdout + verification.stderr);
      assert.match(verification.stdout, /(?:#|ℹ) pass 2\b/, 'both legacy image tests must actually run');
      for (const script of readdirSync(fixture.directory).filter(name => name.endsWith('.sh'))) {
        assert.equal(existsSync(join(target, script)), true, `installed build context is missing ${script}`);
      }
    } finally {
      fixture.clean();
    }
  });
}
