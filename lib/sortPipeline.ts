import type Anthropic from "@anthropic-ai/sdk";
import { parseModelJson } from "@/lib/anthropic";
import {
  buildSortPrompt,
  buildVerifyGroupPrompt,
  buildVerifyMergePrompt,
  slugifyFolderName,
} from "@/lib/prompts";
import { labeledContent, toImageBlock, type WireImage } from "@/lib/images";

const GROUP_MODEL = "claude-sonnet-4-6";
const CHECK_MODEL = "claude-haiku-4-5-20251001";
const BATCH_SIZE = 10;

// A group references photos by their original 0-based index in the uploaded set.
export interface SortGroup {
  name: string;
  photoIndices: number[];
}
export interface SortResult {
  groups: SortGroup[];
  orphanIndices: number[];
}

function firstText(resp: Anthropic.Message): string {
  const block = resp.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

async function claudeJson<T>(
  client: Anthropic,
  model: string,
  content: Anthropic.ContentBlockParam[],
  maxTokens: number
): Promise<T | null> {
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    });
    return parseModelJson<T>(firstText(resp));
  } catch {
    return null;
  }
}

// Step 1 — group photos in batches of 10, carrying the last item forward as
// context so a split across a batch boundary can still be recognized later.
async function groupPhotos(
  client: Anthropic,
  images: WireImage[]
): Promise<{ name: string; indices: number[] }[]> {
  const total = images.length;
  const groups: { name: string; indices: number[] }[] = [];
  let prevContext: Anthropic.ContentBlockParam[] = [];

  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const batch = images.slice(offset, offset + BATCH_SIZE);
    const labelStart = offset + 1;
    const labelEnd = offset + batch.length;

    const content: Anthropic.ContentBlockParam[] = [];
    if (prevContext.length > 0) {
      content.push({
        type: "text",
        text: "For context only — the LAST item from the previous batch (already grouped, do not re-group):",
      });
      content.push(...prevContext);
      content.push({ type: "text", text: "---" });
    }
    content.push(...labeledContent(batch, labelStart));

    const contextNote =
      offset > 0
        ? ` (Continuation — photos ${labelStart}–${labelEnd} of ${total} total. Only group the numbered photos shown above.)`
        : "";
    content.push({
      type: "text",
      text: buildSortPrompt(batch.length, labelStart, labelEnd, contextNote),
    });

    const data = await claudeJson<{
      groups?: { folder_name?: string; photo_indices?: number[] }[];
    }>(client, GROUP_MODEL, content, 2000);
    if (!data?.groups) continue;

    for (const g of data.groups) {
      const indices: number[] = [];
      for (const idx of g.photo_indices ?? []) {
        const real = Number(idx) - 1;
        if (Number.isInteger(real) && real >= 0 && real < total) {
          indices.push(real);
        }
      }
      if (indices.length === 0) continue;
      groups.push({ name: slugifyFolderName(g.folder_name ?? "item"), indices });
    }

    // Context for next batch: the last two photos of the most recent group.
    if (groups.length > 0) {
      const last = groups[groups.length - 1].indices.slice(-2);
      prevContext = labeledContent(
        last.map((i) => images[i]),
        1
      );
    }
  }
  return groups;
}

// Step 2 — verify each multi-photo group for accidentally mixed items.
async function verifyGroups(
  client: Anthropic,
  images: WireImage[],
  groups: { name: string; indices: number[] }[]
): Promise<{ groups: { name: string; indices: number[] }[]; orphans: number[] }> {
  const orphans: number[] = [];

  const checks = await Promise.all(
    groups.map(async (group) => {
      if (group.indices.length === 1) return group;
      const content = labeledContent(
        group.indices.map((i) => images[i]),
        1
      );
      content.push({
        type: "text",
        text: buildVerifyGroupPrompt(group.indices.length),
      });
      const result = await claudeJson<{
        valid?: boolean;
        keep_indices?: number[];
      }>(client, CHECK_MODEL, content, 300);

      if (!result || result.valid !== false) return group;

      const keepRaw = result.keep_indices ?? [];
      if (keepRaw.length === 0) return group;
      const keepSet = new Set(keepRaw.map((x) => Number(x) - 1));
      const kept: number[] = [];
      group.indices.forEach((globalIdx, localIdx) => {
        if (keepSet.has(localIdx)) kept.push(globalIdx);
        else orphans.push(globalIdx);
      });
      return kept.length > 0
        ? { name: group.name, indices: kept }
        : group;
    })
  );

  return { groups: checks, orphans };
}

// Step 3 — merge adjacent groups that are really one item split in two.
// Pairwise checks are independent, so run them together and apply greedily.
async function mergeSplitGroups(
  client: Anthropic,
  images: WireImage[],
  groups: { name: string; indices: number[] }[]
): Promise<{ name: string; indices: number[] }[]> {
  if (groups.length < 2) return groups;

  const pairVotes = await Promise.all(
    groups.slice(0, -1).map(async (group, i) => {
      const next = groups[i + 1];
      const aBlock = toImageBlock(images[group.indices[0]]);
      const bBlock = toImageBlock(images[next.indices[0]]);
      if (!aBlock || !bBlock) return false;
      const content: Anthropic.ContentBlockParam[] = [
        { type: "text", text: "Photo 1:" },
        aBlock,
        { type: "text", text: "--- Group B ---" },
        { type: "text", text: "Photo 2:" },
        bBlock,
        {
          type: "text",
          text: buildVerifyMergePrompt(group.indices.length, next.indices.length),
        },
      ];
      const result = await claudeJson<{ merge?: boolean }>(
        client,
        CHECK_MODEL,
        content,
        100
      );
      return result?.merge === true;
    })
  );

  const merged: { name: string; indices: number[] }[] = [];
  let i = 0;
  while (i < groups.length) {
    if (i < groups.length - 1 && pairVotes[i]) {
      merged.push({
        name: groups[i].name,
        indices: [...groups[i].indices, ...groups[i + 1].indices],
      });
      i += 2; // consume both; don't chain-merge the next pair
    } else {
      merged.push(groups[i]);
      i += 1;
    }
  }
  return merged;
}

// De-duplicate folder names (item, item-2, item-3, ...).
function uniqueNames(groups: { name: string; indices: number[] }[]): SortGroup[] {
  const counts = new Map<string, number>();
  return groups.map((g) => {
    const n = (counts.get(g.name) ?? 0) + 1;
    counts.set(g.name, n);
    return {
      name: n === 1 ? g.name : `${g.name}-${n}`,
      photoIndices: g.indices,
    };
  });
}

export async function sortPhotos(
  client: Anthropic,
  images: WireImage[]
): Promise<SortResult> {
  const grouped = await groupPhotos(client, images);
  if (grouped.length === 0) return { groups: [], orphanIndices: [] };
  const verified = await verifyGroups(client, images, grouped);
  const merged = await mergeSplitGroups(client, images, verified.groups);
  return {
    groups: uniqueNames(merged),
    orphanIndices: verified.orphans,
  };
}
