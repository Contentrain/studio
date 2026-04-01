import sharp from 'sharp'

/**
 * Upload a custom avatar image.
 * Resizes to 256x256 WebP, stores as base64 data URI in profiles.avatar_url.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()

  const formData = await readMultipartFormData(event)
  if (!formData?.length)
    throw createError({ statusCode: 400, message: errorMessage('profile.avatar_no_file') })

  const filePart = formData.find(p => p.name === 'file')
  if (!filePart?.data || !filePart.filename)
    throw createError({ statusCode: 400, message: errorMessage('profile.avatar_no_file') })

  const contentType = filePart.type ?? ''
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  if (!allowedTypes.includes(contentType))
    throw createError({ statusCode: 400, message: errorMessage('profile.avatar_invalid_type') })

  if (filePart.data.length > 2 * 1024 * 1024)
    throw createError({ statusCode: 400, message: errorMessage('profile.avatar_too_large') })

  const webpBuffer = await sharp(Buffer.from(filePart.data))
    .resize(256, 256, { fit: 'cover', position: 'centre' })
    .webp({ quality: 80 })
    .toBuffer()

  const dataUri = `data:image/webp;base64,${webpBuffer.toString('base64')}`

  const profile = await db.updateProfile(session.accessToken, session.user.id, { avatar_url: dataUri })

  return { avatarUrl: profile.avatar_url }
})
