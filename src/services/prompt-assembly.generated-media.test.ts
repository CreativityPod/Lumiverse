import { describe, expect, test } from "bun:test";
import type { Message, MessageAttachment } from "../types/message";
import {
  attachmentsForContext,
  resolveGeneratedMediaContextPolicy,
} from "./prompt-assembly.service";

function attachment(type: "image" | "video", id: string): MessageAttachment {
  return {
    type,
    image_id: id,
    mime_type: type === "video" ? "video/mp4" : "image/png",
    original_filename: `${id}.${type === "video" ? "mp4" : "png"}`,
  };
}

function message(
  id: string,
  attachments: MessageAttachment[],
  generated: boolean,
): Message {
  return {
    id,
    chat_id: "chat",
    index_in_chat: 0,
    is_user: false,
    name: "ImageGen",
    content: "",
    send_date: 0,
    swipe_id: 0,
    swipes: [""],
    swipe_dates: [0],
    extra: {
      attachments,
      ...(generated ? { image_gen: { provider: "comfyui" } } : {}),
    },
    parent_message_id: null,
    branch_id: null,
    created_at: 0,
  };
}

describe("generated media context policy", () => {
  test("keeps manual video attachments in context", () => {
    const manual = message("manual", [attachment("video", "manual-video")], false);
    const policy = resolveGeneratedMediaContextPolicy({}, [manual]);
    expect(attachmentsForContext(manual, policy).map((item) => item.image_id)).toEqual(["manual-video"]);
  });

  test("keeps generated videos display-only by default", () => {
    const generated = message("generated", [attachment("video", "generated-video")], true);
    const policy = resolveGeneratedMediaContextPolicy({}, [generated]);
    expect(attachmentsForContext(generated, policy)).toEqual([]);
  });

  test("applies independent image and video recycling limits", () => {
    const older = message("older", [attachment("image", "image-old"), attachment("video", "video-old")], true);
    const newer = message("newer", [attachment("image", "image-new"), attachment("video", "video-new")], true);
    const policy = resolveGeneratedMediaContextPolicy({
      recycleGeneratedImages: true,
      recycledImageLimit: 2,
      recycleGeneratedVideos: true,
      recycledVideoLimit: 1,
    }, [older, newer]);

    expect(attachmentsForContext(newer, policy).map((item) => item.image_id)).toEqual(["image-new", "video-new"]);
    expect(attachmentsForContext(older, policy).map((item) => item.image_id)).toEqual(["image-old"]);
  });
});

