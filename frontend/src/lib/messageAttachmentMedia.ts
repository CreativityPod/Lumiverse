import type { MessageAttachment } from '@/types/api'

export type VisualAttachmentKind = 'image' | 'video'

type AttachmentMediaDescriptor = Pick<
  MessageAttachment,
  'type' | 'mime_type' | 'original_filename'
>

const VIDEO_FILENAME_RE = /\.(?:mp4|m4v|mov|webm|mpeg|mpg|avi|flv|wmv|3gp)$/i

/**
 * Resolve the visual renderer from all durable media metadata. MIME and the
 * filename deliberately get a chance to repair legacy/malformed attachments
 * whose discriminator says "image" even though the stored asset is a video.
 */
export function resolveVisualAttachmentKind(
  attachment: AttachmentMediaDescriptor,
): VisualAttachmentKind | null {
  const mimeType = attachment.mime_type?.trim().toLowerCase() ?? ''
  const filename = attachment.original_filename?.trim() ?? ''

  if (
    attachment.type === 'video'
    || mimeType.startsWith('video/')
    || VIDEO_FILENAME_RE.test(filename)
  ) {
    return 'video'
  }

  if (attachment.type === 'image' || mimeType.startsWith('image/')) return 'image'
  return null
}
