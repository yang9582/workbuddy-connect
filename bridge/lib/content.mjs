/** 请求内容里是否包含图片块（OpenAI `image_url` / Anthropic `image` / Responses `input_image`）。 */

export function hasImageParts(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "image_url" || part.type === "image" || part.type === "input_image") return true;
    }
  }
  return false;
}
