import type Anthropic from "@anthropic-ai/sdk";

export type WireImage = { mediaType: string; data: string };
export type ImageBlock = Anthropic.ImageBlockParam;
type MediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

// Anthropic rejects any single image over 5 MB. Browser resizing keeps photos
// far under this, but guard anyway so a stray large image is skipped cleanly.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);

// Strip an optional data-url prefix to get raw base64.
function rawBase64(data: string): string {
  return data.includes(",") ? data.split(",")[1] : data;
}

function validImage(img: WireImage | undefined): { mediaType: MediaType; data: string } | null {
  if (!img?.data || !ALLOWED_MEDIA.has(img.mediaType)) return null;
  const data = rawBase64(img.data);
  if (data.length * 0.75 > MAX_IMAGE_BYTES) return null;
  return { mediaType: img.mediaType as MediaType, data };
}

export function isValidImage(img: WireImage | undefined): boolean {
  return validImage(img) !== null;
}

export function toImageBlock(img: WireImage | undefined): ImageBlock | null {
  const v = validImage(img);
  if (!v) return null;
  return { type: "image", source: { type: "base64", media_type: v.mediaType, data: v.data } };
}

export type OpenAIImagePart = { type: "image_url"; image_url: { url: string } };

// Same image, OpenAI-compatible chat-completions shape (data-URL, not a
// separate base64 field) — shared by every OpenAI-compatible provider
// (OpenRouter, OmniRoute, ...).
export function toOpenAIImagePart(img: WireImage | undefined): OpenAIImagePart | null {
  const v = validImage(img);
  if (!v) return null;
  return { type: "image_url", image_url: { url: `data:${v.mediaType};base64,${v.data}` } };
}

// Chat-completions content-part shape shared by every OpenAI-compatible
// provider this app talks to.
export type OpenAIChatContentPart = { type: "text"; text: string } | OpenAIImagePart;

// Chat-completions result shape shared by every OpenAI-compatible provider
// (OpenRouter, OmniRoute, ...) — kept minimal since none of them expose
// Anthropic's prompt-caching usage fields.
export interface OpenAIChatResult {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
}

// ── Provider-agnostic content parts ──────────────────────────────────────────
// A minimal, provider-neutral content model that lib/providers.ts converts into
// whichever shape the chosen provider's API expects, so callers (server/api.ts,
// lib/sortPipeline.ts) don't need to know about Anthropic- or OpenAI-specific
// content block types.
export type GenericContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: WireImage };

// Build "Photo N:" text + image parts for a set of images, matching
// _images_to_content() in the Python script.
export function labeledParts(images: WireImage[], labelStart = 1): GenericContentPart[] {
  const parts: GenericContentPart[] = [];
  images.forEach((img, i) => {
    if (!isValidImage(img)) return;
    parts.push({ type: "text", text: `Photo ${labelStart + i}:` });
    parts.push({ type: "image", image: img });
  });
  return parts;
}
