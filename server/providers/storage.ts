export interface StorageFile {
  path: string
  url: string
  size: number
  contentType: string
}

export interface StorageProvider {
  /**
   * Upload a file to a bucket
   */
  upload: (bucket: string, path: string, file: Buffer | Blob, contentType: string) => Promise<StorageFile>

  /**
   * Get a public URL for a file
   */
  getPublicUrl: (bucket: string, path: string) => string

  /**
   * Delete a file from a bucket
   */
  remove: (bucket: string, path: string) => Promise<void>

  /**
   * List files in a bucket path
   */
  list: (bucket: string, path?: string) => Promise<StorageFile[]>
}
