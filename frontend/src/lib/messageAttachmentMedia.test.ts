import { describe, expect, test } from 'bun:test'
import { resolveVisualAttachmentKind } from './messageAttachmentMedia'

describe('resolveVisualAttachmentKind', () => {
  test('keeps first-class video attachments on the video renderer', () => {
    expect(resolveVisualAttachmentKind({
      type: 'video',
      mime_type: 'video/mp4',
      original_filename: 'scene.mp4',
    })).toBe('video')
  })

  test('repairs an MP4 attachment incorrectly tagged as an image', () => {
    expect(resolveVisualAttachmentKind({
      type: 'image',
      mime_type: 'video/mp4',
      original_filename: 'scene.mp4',
    })).toBe('video')
  })

  test('uses the filename when an older attachment has a generic MIME type', () => {
    expect(resolveVisualAttachmentKind({
      type: 'image',
      mime_type: 'application/octet-stream',
      original_filename: 'scene.MP4',
    })).toBe('video')
  })

  test('keeps images in the image lightbox and excludes audio', () => {
    expect(resolveVisualAttachmentKind({
      type: 'image',
      mime_type: 'image/webp',
      original_filename: 'scene.webp',
    })).toBe('image')
    expect(resolveVisualAttachmentKind({
      type: 'audio',
      mime_type: 'audio/mpeg',
      original_filename: 'voice.mp3',
    })).toBeNull()
  })
})
