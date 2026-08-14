import type { UseStore } from 'idb-keyval'

/**
 * Two idb-keyval stores in ONE database.
 *
 * `idb-keyval`'s own `createStore` opens the database **without a version** and
 * creates only its own object store in the upgrade. Call it twice for the same
 * database and only the first store is ever created: by the time the second one
 * opens, the database already exists at version 1, no upgrade fires, and every
 * transaction against it throws `NotFoundError`.
 *
 * The brain needs two — `brain-meta` and `brain-content` — so it needs this.
 * The database is opened once, at an explicit version, and both stores are
 * created in that single upgrade.
 *
 * The version is 2 rather than 1 on purpose: a browser that already visited
 * Studio holds `cr-brain` at version 1 with whichever store happened to be
 * touched first. Opening at 1 would find it current and fire no upgrade, so the
 * missing store would stay missing. Bumping forces the upgrade that creates it.
 */
const DB_VERSION = 2

/**
 * Returns one `UseStore` per name, all sharing a single database connection —
 * the shape `idb-keyval`'s `get` / `set` / `del` / `keys` already accept, so
 * call sites do not change.
 */
export function createSharedStores<const N extends readonly string[]>(
  dbName: string,
  storeNames: N,
): Record<N[number], UseStore> {
  let dbp: Promise<IDBDatabase> | undefined

  const getDB = () => {
    if (dbp) return dbp

    dbp = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION)

      request.onupgradeneeded = () => {
        const db = request.result
        for (const name of storeNames) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
        }
      }

      // Another tab holding an older version blocks the upgrade. Reject rather
      // than leave every read pending forever: an error is recoverable and
      // visible, a promise that never settles is neither. `onversionchange`
      // below means this should not happen, but "should not" is not "cannot".
      request.onblocked = () => reject(new Error('brain database upgrade blocked by another tab'))

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        // Step aside when another tab wants to upgrade, instead of being the
        // tab that blocks it.
        db.onversionchange = () => {
          db.close()
          dbp = undefined
        }
        // Safari sometimes closes the connection on its own and says so here.
        db.onclose = () => {
          dbp = undefined
        }
        resolve(db)
      }
    })

    // A failed open must not be cached, or one blocked upgrade would poison
    // every later call for the lifetime of the worker.
    dbp.catch(() => {
      dbp = undefined
    })
    return dbp
  }

  const stores = {} as Record<string, UseStore>
  for (const name of storeNames) {
    stores[name] = ((txMode, callback) =>
      getDB().then(db => callback(db.transaction(name, txMode).objectStore(name)))) as UseStore
  }
  return stores as Record<N[number], UseStore>
}
