import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/lib/anthropic";
import { sortPhotos } from "@/lib/sortPipeline";
import type { WireImage } from "@/lib/images";

// Sorting makes several model calls across grouping/verify/merge stages.
export const maxDuration = 120;

const MAX_PHOTOS = 120;

export async function POST(req: NextRequest) {
  let body: { images?: WireImage[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 }
    );
  }

  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_PHOTOS) : [];
  if (images.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Please add some photos first." },
      { status: 400 }
    );
  }

  let client;
  try {
    client = getClient();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }

  try {
    const result = await sortPhotos(client, images);
    if (result.groups.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Couldn't sort these photos. Try fewer at a time." },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sorting failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
