---
title: Attachments
---

# Attachments

You can send images, audio files, and videos alongside your messages. When the AI and provider support the attachment type, the model can see or hear it and respond to it.

---

## Sending an Attachment

1. Click the **Attachment** button in the input area (or drag a file into the chat)
2. Select an image, audio file, or video
3. The attachment appears as a preview in the input area
4. Type your message (optional) and send

The attachment is uploaded to Lumiverse's shared media system and stored alongside the message.

---

## Supported Formats

| Type | Formats |
|------|---------|
| **Images** | PNG, JPG, WebP, GIF |
| **Audio** | WAV, MP3, and other common audio formats |
| **Video** | MP4 and other common browser video formats; MP4 is recommended |

---

## How the AI Sees Attachments

When you send a message with an attachment, Lumiverse stores it with the message and includes supported media as multipart prompt content. The AI receives the text and any media type supported by the selected provider.

Generated image and video attachments are display-only by default. You can independently enable **Recycle Generated Images Into Context** or **Recycle Generated Videos Into Context** in **Image & Video Generation** when you want recent generated results sent again on later turns. Manually uploaded attachments continue to follow the normal attachment behavior.

!!! note "Model support"
    Not all AI models support image, audio, or video input. If your current model doesn't support an attachment type, the attachment is still saved with the message but may not influence the AI's response. Google providers accept video input; other provider adapters may omit it when their API has no video content part.

Provider-specific formatting is handled automatically:

- **OpenAI** — Uses `image_url` and `input_audio` content parts
- **Anthropic** — Uses `image` source blocks
- **Google** — Uses `inlineData` parts for images, audio, and video

---

## Viewing Attachments

Attachments appear inline in the message. Click an image to open it in the **Image Lightbox**, or use the controls on a video attachment to play it inline. Right-click or long-press an attachment to remove it from the message.
