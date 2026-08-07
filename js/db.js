'use strict';

(function exposeDatabase(global) {
  const DB_NAME = 'ofertanalisis_db';
  const DB_VERSION = 2;
  const STORE_TESTS = 'tests';
  const STORE_META = 'meta';
  const STORE_AUDIT = 'audit';
  const DEFAULT_PIN = '1234';
  const PIN_ITERATIONS = 120000;
  const SYNC_CHANNEL = 'ofertanalisis-preanalitica-sync';

  let dbPromise = null;
  let channel = null;
  const changeListeners = new Set();

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Error de IndexedDB.'));
    });
  }

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const tx = event.target.transaction;

        if (!db.objectStoreNames.contains(STORE_TESTS)) {
          db.createObjectStore(STORE_TESTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_AUDIT)) {
          const audit = db.createObjectStore(STORE_AUDIT, { keyPath: 'id' });
          audit.createIndex('createdAt', 'createdAt');
          audit.createIndex('action', 'action');
        } else if (tx) {
          const audit = tx.objectStore(STORE_AUDIT);
          if (!audit.indexNames.contains('createdAt')) {
            audit.createIndex('createdAt', 'createdAt');
          }
          if (!audit.indexNames.contains('action')) {
            audit.createIndex('action', 'action');
          }
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('No se pudo abrir la base local.'));
      };
      request.onblocked = () => reject(new Error('Cierre otras pestañas de la aplicación para actualizar la base local.'));
    });

    return dbPromise;
  }

  async function runTransaction(storeNames, mode, work) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
      let result;

      try {
        result = work(stores, tx);
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('La operación local no pudo completarse.'));
      tx.onabort = () => reject(tx.error || new Error('La operación local fue cancelada.'));
    });
  }

  async function getAllTests() {
    const db = await openDB();
    const tx = db.transaction(STORE_TESTS, 'readonly');
    return requestToPromise(tx.objectStore(STORE_TESTS).getAll());
  }

  async function countTests() {
    const db = await openDB();
    const tx = db.transaction(STORE_TESTS, 'readonly');
    return requestToPromise(tx.objectStore(STORE_TESTS).count());
  }

  async function getMeta(key) {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readonly');
    const record = await requestToPromise(tx.objectStore(STORE_META).get(key));
    return record?.value ?? null;
  }

  function setMeta(key, value) {
    return runTransaction([STORE_META], 'readwrite', ({ meta }) => {
      meta.put({ key, value });
      return true;
    });
  }

  function createAudit(action, summary, details = null) {
    return {
      id: global.crypto?.randomUUID?.() || `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      action: String(action || 'cambio'),
      summary: String(summary || ''),
      details,
      createdAt: new Date().toISOString()
    };
  }

  async function upsertTest(test, action = 'actualización') {
    const auditRecord = createAudit(action, `${action === 'creación' ? 'Creada' : 'Actualizada'}: ${test.nombre || 'Prueba sin nombre'}`, { testId: test.id });
    await runTransaction([STORE_TESTS, STORE_AUDIT], 'readwrite', ({ tests, audit }) => {
      tests.put(test);
      audit.put(auditRecord);
    });
    notifyChange('tests');
    return test;
  }

  async function deleteTest(id, name = '') {
    const auditRecord = createAudit('eliminación', `Eliminada: ${name || String(id)}`, { testId: id });
    await runTransaction([STORE_TESTS, STORE_AUDIT], 'readwrite', ({ tests, audit }) => {
      tests.delete(id);
      audit.put(auditRecord);
    });
    notifyChange('tests');
  }

  async function replaceTests(tests, options = {}) {
    const list = Array.isArray(tests) ? tests : [];
    const action = options.action || 'restauración';
    const summary = options.summary || `Base reemplazada con ${list.length} registros.`;
    const auditRecord = createAudit(action, summary, { count: list.length, source: options.source || '' });

    await runTransaction([STORE_TESTS, STORE_META, STORE_AUDIT], 'readwrite', ({ tests: store, meta, audit }) => {
      store.clear();
      for (const item of list) store.put(item);
      if (options.meta && typeof options.meta === 'object') {
        for (const [key, value] of Object.entries(options.meta)) meta.put({ key, value });
      }
      audit.put(auditRecord);
    });
    notifyChange('tests');
    return list;
  }

  async function getAudit(limit = 250) {
    const db = await openDB();
    const tx = db.transaction(STORE_AUDIT, 'readonly');
    const all = await requestToPromise(tx.objectStore(STORE_AUDIT).getAll());
    return all
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, Math.max(1, Number(limit) || 250));
  }

  async function exportBackup() {
    const [tests, audit, sourceVersion, sourceLabel] = await Promise.all([
      getAllTests(),
      getAudit(5000),
      getMeta('catalog_source_version'),
      getMeta('catalog_source_label')
    ]);
    return {
      schema: 'preanalitica-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      sourceVersion: sourceVersion || '',
      sourceLabel: sourceLabel || '',
      tests,
      audit
    };
  }

  async function importBackup(payload, normalizedTests) {
    const auditList = Array.isArray(payload?.audit) ? payload.audit : [];
    const restoreAudit = createAudit('importación', `Importado respaldo con ${normalizedTests.length} registros.`, { count: normalizedTests.length });

    await runTransaction([STORE_TESTS, STORE_META, STORE_AUDIT], 'readwrite', ({ tests, meta, audit }) => {
      tests.clear();
      audit.clear();
      for (const item of normalizedTests) tests.put(item);
      for (const entry of auditList.slice(-5000)) {
        if (!entry || (typeof entry.id !== 'string' && typeof entry.id !== 'number')) continue;
        const createdAt = new Date(entry.createdAt);
        if (Number.isNaN(createdAt.getTime())) continue;
        audit.put({
          id: String(entry.id).slice(0, 160),
          action: String(entry.action || 'cambio').slice(0, 120),
          summary: String(entry.summary || '').slice(0, 4000),
          details: entry.details && typeof entry.details === 'object' ? entry.details : null,
          createdAt: createdAt.toISOString()
        });
      }
      audit.put(restoreAudit);
      meta.put({ key: 'last_restore', value: new Date().toISOString() });
      meta.put({ key: 'catalog_source_label', value: payload?.sourceLabel || 'Respaldo importado' });
      if (payload?.sourceVersion) meta.put({ key: 'catalog_source_version', value: payload.sourceVersion });
    });
    notifyChange('tests');
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  async function derivePinHash(pin, saltBase64) {
    if (!global.crypto?.subtle) return `legacy:${String(pin)}`;
    const encoder = new TextEncoder();
    const salt = Uint8Array.from(atob(saltBase64), (char) => char.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', encoder.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PIN_ITERATIONS, hash: 'SHA-256' }, key, 256);
    return bytesToBase64(new Uint8Array(bits));
  }

  async function setPin(pin) {
    const clean = String(pin || '');
    if (clean.length < 4 || clean.length > 24) throw new Error('El PIN debe contener entre 4 y 24 caracteres.');
    const salt = new Uint8Array(16);
    global.crypto?.getRandomValues?.(salt);
    const saltBase64 = bytesToBase64(salt);
    const hash = await derivePinHash(clean, saltBase64);

    await runTransaction([STORE_META, STORE_AUDIT], 'readwrite', ({ meta, audit }) => {
      meta.put({ key: 'pin_salt', value: saltBase64 });
      meta.put({ key: 'pin_hash', value: hash });
      meta.delete('pin');
      audit.put(createAudit('PIN', 'PIN administrativo actualizado.'));
    });
  }

  async function verifyPin(pin) {
    const [hash, salt, legacyPin] = await Promise.all([getMeta('pin_hash'), getMeta('pin_salt'), getMeta('pin')]);
    if (hash && salt) {
      return (await derivePinHash(pin, salt)) === hash;
    }

    const expected = legacyPin || DEFAULT_PIN;
    const valid = String(pin) === String(expected);
    if (valid) {
      try { await setPin(String(pin)); } catch (_) { /* La verificación sigue siendo válida. */ }
    }
    return valid;
  }

  async function recordBackup() {
    const timestamp = new Date().toISOString();
    await setMeta('last_backup', timestamp);
    return timestamp;
  }

  function setupSync() {
    if ('BroadcastChannel' in global) {
      channel = new BroadcastChannel(SYNC_CHANNEL);
      channel.onmessage = () => emitChange('external');
    }
    global.addEventListener?.('storage', (event) => {
      if (event.key === SYNC_CHANNEL) emitChange('external');
    });
  }

  function notifyChange(reason) {
    try { channel?.postMessage({ reason, at: Date.now() }); } catch (_) {}
    try { localStorage.setItem(SYNC_CHANNEL, String(Date.now())); } catch (_) {}
    emitChange(reason);
  }

  function emitChange(reason) {
    for (const listener of changeListeners) {
      try { listener(reason); } catch (_) {}
    }
  }

  function onChange(listener) {
    if (typeof listener === 'function') changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  }

  setupSync();

  global.PreanalyticsDB = Object.freeze({
    DB_NAME,
    openDB,
    getAllTests,
    countTests,
    getMeta,
    setMeta,
    upsertTest,
    deleteTest,
    replaceTests,
    getAudit,
    exportBackup,
    importBackup,
    verifyPin,
    setPin,
    recordBackup,
    onChange
  });
})(window);
