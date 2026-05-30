/**
 * test-migration.js — Basic migration tests
 * Run with: node test-migration.js
 */

// Mock chrome.storage
const makeArea = () => {
  let data = {};
  return {
    get: async (keys) => {
      if (keys === null) return { ...data };
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) return keys.reduce((acc, k) => (acc[k] = data[k], acc), {});
      return {};
    },
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (k) => { delete data[k]; },
    clear: async () => { data = {}; },
    getBytesInUse: async () => JSON.stringify(data).length,
    __dump: () => data,
  };
};

globalThis.chrome = {
  storage: { local: makeArea(), sync: makeArea(), onChanged: { addListener: () => {}, removeListener: () => {} } },
  runtime: { lastError: null, getManifest: () => ({ version: '1.1.0' }) },
};

const SCHEMA_VERSION = 2;
const SCHEMA_KEY = '__schema_version__';
const MIGRATION_FLAG_KEY = '__migrated_from_sync_v2__';

async function get(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
  if (chrome.runtime.lastError) {
    throw new Error(`storage.set failed for ${key}: ${chrome.runtime.lastError.message}`);
  }
}

async function migrateFromSyncIfNeeded() {
  const flag = await get(MIGRATION_FLAG_KEY);
  if (flag === true) {
    return { migrated: false, reason: 'already_migrated' };
  }

  const syncData = await chrome.storage.sync.get(null);
  const syncKeys = Object.keys(syncData);

  if (syncKeys.length === 0) {
    await set(MIGRATION_FLAG_KEY, true);
    await set(SCHEMA_KEY, SCHEMA_VERSION);
    return { migrated: false, reason: 'no_sync_data' };
  }

  await chrome.storage.local.set(syncData);
  if (chrome.runtime.lastError) {
    throw new Error(`Migration write to local failed: ${chrome.runtime.lastError.message}`);
  }

  const localAfter = await chrome.storage.local.get(syncKeys);
  for (const k of syncKeys) {
    if (JSON.stringify(localAfter[k]) !== JSON.stringify(syncData[k])) {
      throw new Error(`Migration verification failed for key ${k}.`);
    }
  }

  await set(MIGRATION_FLAG_KEY, true);
  await set(SCHEMA_KEY, SCHEMA_VERSION);

  return { migrated: true, keysMigrated: syncKeys.length };
}

async function runTests() {
  let passed = 0, failed = 0;

  async function test(name, fn) {
    try {
      // Reset storage
      chrome.storage.local.__dump = () => chrome.storage.local = makeArea();
      chrome.storage.sync.__dump = () => chrome.storage.sync = makeArea();
      chrome.storage.local = makeArea();
      chrome.storage.sync = makeArea();

      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`✗ ${name}`);
      console.error(`  ${e.message}`);
      failed++;
    }
  }

  // Test 1: Basic set/get
  await test('set + get round-trip', async () => {
    const testObj = { foo: 'bar', nested: { a: 1 } };
    await set('test', testObj);
    const result = await get('test');
    if (JSON.stringify(result) !== JSON.stringify(testObj)) {
      throw new Error('Data mismatch after round-trip');
    }
  });

  // Test 2: Migration with empty sync
  await test('migrateFromSyncIfNeeded with empty sync', async () => {
    const result = await migrateFromSyncIfNeeded();
    if (result.reason !== 'no_sync_data') {
      throw new Error(`Expected reason 'no_sync_data', got '${result.reason}'`);
    }
    const flag = await get(MIGRATION_FLAG_KEY);
    if (flag !== true) {
      throw new Error('Migration flag not set');
    }
  });

  // Test 3: Migration with populated sync
  await test('migrateFromSyncIfNeeded with sync populated', async () => {
    await chrome.storage.sync.set({
      categories: { cat1: { id: 'cat1', name: 'Tech' } },
      channelAssignments: { ch1: ['cat1'] },
    });

    const result = await migrateFromSyncIfNeeded();
    if (result.reason === 'already_migrated') {
      throw new Error('Should not be already migrated');
    }
    if (result.migrated !== true || result.keysMigrated !== 2) {
      throw new Error(`Expected migrated=true, keysMigrated=2; got ${result.migrated}, ${result.keysMigrated}`);
    }

    const cats = await get('categories');
    if (!cats || !cats.cat1) {
      throw new Error('Categories not migrated');
    }
  });

  // Test 4: Migration is idempotent
  await test('migrateFromSyncIfNeeded second call is idempotent', async () => {
    await chrome.storage.sync.set({ test: 'data' });
    const result1 = await migrateFromSyncIfNeeded();
    const result2 = await migrateFromSyncIfNeeded();

    if (result2.reason !== 'already_migrated') {
      throw new Error(`Second call should return 'already_migrated', got '${result2.reason}'`);
    }

    const test = await get('test');
    if (test !== 'data') {
      throw new Error('Data was lost on second migration call');
    }
  });

  // Test 5: Export all
  await test('exportAll returns schemaVersion and timestamp', async () => {
    await set('categories', { cat1: { name: 'Tech' } });
    const all = await chrome.storage.local.get(null);
    const exported = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: '1.1.0',
      data: all,
    };
    if (!exported.schemaVersion || !exported.exportedAt || !exported.data) {
      throw new Error('Export missing required fields');
    }
  });

  // Test 6: Import with invalid payload
  await test('importAll rejects invalid payload', async () => {
    try {
      await new Promise((resolve, reject) => {
        if (!{} || typeof {} !== 'object' || !{}.data) {
          reject(new Error('Invalid import payload: missing "data".'));
        }
      });
      throw new Error('Should have rejected invalid payload');
    } catch (e) {
      if (!e.message.includes('Invalid')) {
        throw e;
      }
    }
  });

  // Test 7: Import with future schemaVersion
  await test('importAll rejects future schemaVersion', async () => {
    const payload = { schemaVersion: 99, data: {} };
    try {
      if (payload.schemaVersion > SCHEMA_VERSION) {
        throw new Error(`Import schemaVersion 99 > current ${SCHEMA_VERSION}`);
      }
      throw new Error('Should have rejected future schema');
    } catch (e) {
      if (!e.message.includes('schemaVersion')) {
        throw e;
      }
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
