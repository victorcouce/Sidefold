# Notas de Migración: chrome.storage.sync → chrome.storage.local

## Resumen
Migración de storage de `chrome.storage.sync` (100KB limit) a `chrome.storage.local` (ilimitado con permiso `unlimitedStorage`).

## Referencias encontradas

### 1. `src/background/background.js:21`
- **Tipo**: Lectura (callback-based)
- **Código**: `chrome.storage.sync.get('categories', (data) => { ... })`
- **Keys usadas**: `categories`
- **Acción requerida**: Reemplazar por abstracción de storage.js (migrará a Promise-based)

### 2. `src/shared/storage.js` (helpers internos)
- **syncGet()** (línea 39): Lee de `chrome.storage.sync`
- **syncSet()** (línea 47): Escribe a `chrome.storage.sync`
- **localGet()** (línea 55): Lee de `chrome.storage.local` (ya existe)
- **localSet()** (línea 63): Escribe a `chrome.storage.local` (ya existe)
- **onChange()** (línea 236): Listener en `chrome.storage.onChanged` filtrando por `areaName === 'sync'`

### 3. Keys usadas en sync storage
- `categories` — objeto con ID → {id, name, order, hue, collapsed}
- `channelAssignments` — objeto con channelId → [categoryIds]
- `settings` — objeto con {showUncategorized, collapseByDefault, subscriptionsLayout}

### 4. Keys usadas en local storage
- `cachedChannels` — array de canales (cache)
- `channelsCachedAt` — timestamp

## Plan de refactor

1. **storage.js**: Migrar helpers internos (syncGet/syncSet) a usar `chrome.storage.local`
2. **background.js**: Reemplazar callback-based call por abstracción
3. **manifest.json**: Añadir permiso `unlimitedStorage` y bumper version a 1.1.0
4. **background.js onInstalled**: Añadir llamada a `migrateFromSyncIfNeeded()`
5. Crear funciones `exportAll()` e `importAll()` en storage.js
6. Añadir UI (Export/Import buttons) en panel-ui.js
7. Tests para migration logic
8. CHANGELOG y README
