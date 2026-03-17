export interface DatabaseProvider {
  /**
   * Execute a query and return rows
   */
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>

  /**
   * Execute a query and return a single row
   */
  queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>

  /**
   * Execute a mutation (insert, update, delete) and return affected count
   */
  execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }>

  /**
   * Run a callback within a transaction
   */
  transaction: <T>(fn: (tx: DatabaseProvider) => Promise<T>) => Promise<T>
}
