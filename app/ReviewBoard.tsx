"use client";

import type { ItemGroup, Photo } from "@/lib/types";

interface ReviewBoardProps {
  groups: ItemGroup[];
  orphanIds: string[];
  photoById: (id: string) => Photo | undefined;
  onRename: (groupId: string, name: string) => void;
  onMovePhoto: (photoId: string, toGroupId: string | "orphans") => void;
  onDeleteGroup: (groupId: string) => void;
  onAddGroup: () => void;
  onWriteAll: () => void;
  onBack: () => void;
}

function MoveSelect({
  photoId,
  currentGroupId,
  groups,
  onMovePhoto,
}: {
  photoId: string;
  currentGroupId: string | "orphans";
  groups: ItemGroup[];
  onMovePhoto: ReviewBoardProps["onMovePhoto"];
}) {
  return (
    <select
      className="move-select"
      value={currentGroupId}
      aria-label="Move photo to a different item"
      onChange={(e) => onMovePhoto(photoId, e.target.value as string)}
      onClick={(e) => e.stopPropagation()}
    >
      {groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
      <option value="orphans">Needs review</option>
    </select>
  );
}

function Thumb({
  photoId,
  groupId,
  groups,
  photoById,
  onMovePhoto,
}: {
  photoId: string;
  groupId: string | "orphans";
  groups: ItemGroup[];
  photoById: ReviewBoardProps["photoById"];
  onMovePhoto: ReviewBoardProps["onMovePhoto"];
}) {
  const photo = photoById(photoId);
  if (!photo) return null;
  return (
    <figure className="board-thumb">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.previewUrl} alt="Item photo" />
      <MoveSelect
        photoId={photoId}
        currentGroupId={groupId}
        groups={groups}
        onMovePhoto={onMovePhoto}
      />
    </figure>
  );
}

export function ReviewBoard({
  groups,
  orphanIds,
  photoById,
  onRename,
  onMovePhoto,
  onDeleteGroup,
  onAddGroup,
  onWriteAll,
  onBack,
}: ReviewBoardProps) {
  const totalPhotos =
    groups.reduce((n, g) => n + g.photoIds.length, 0) + orphanIds.length;
  const usableGroups = groups.filter((g) => g.photoIds.length > 0);

  return (
    <section className="panel" aria-labelledby="review-heading">
      <div className="result-head">
        <h3 id="review-heading">
          {groups.length} item{groups.length === 1 ? "" : "s"} found
        </h3>
        <span className="badge">{totalPhotos} photos sorted</span>
      </div>
      <p style={{ marginTop: 0, color: "var(--color-ink-soft)" }}>
        Check the groupings below. Rename an item, or use the menu under any
        photo to move it to the right item. Then write all the listings at once.
      </p>

      <div className="board">
        {groups.map((group) => (
          <article className="board-item" key={group.id}>
            <header className="board-item-head">
              <input
                type="text"
                className="board-name"
                value={group.name}
                aria-label="Item name"
                onChange={(e) => onRename(group.id, e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost danger"
                aria-label={`Delete ${group.name}`}
                onClick={() => onDeleteGroup(group.id)}
              >
                Delete
              </button>
            </header>
            {group.photoIds.length === 0 ? (
              <p className="board-empty">
                Empty — move photos here using the menu under a photo.
              </p>
            ) : (
              <div className="board-thumbs">
                {group.photoIds.map((pid) => (
                  <Thumb
                    key={pid}
                    photoId={pid}
                    groupId={group.id}
                    groups={groups}
                    photoById={photoById}
                    onMovePhoto={onMovePhoto}
                  />
                ))}
              </div>
            )}
          </article>
        ))}
      </div>

      {orphanIds.length > 0 && (
        <article className="board-item needs-review">
          <header className="board-item-head">
            <strong>⚠️ Needs review ({orphanIds.length})</strong>
            <span style={{ fontSize: "0.82rem", color: "var(--color-ink-faint)" }}>
              These didn&rsquo;t clearly belong to one item — assign each below.
            </span>
          </header>
          <div className="board-thumbs">
            {orphanIds.map((pid) => (
              <Thumb
                key={pid}
                photoId={pid}
                groupId="orphans"
                groups={groups}
                photoById={photoById}
                onMovePhoto={onMovePhoto}
              />
            ))}
          </div>
        </article>
      )}

      <div className="result-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ← Back to photos
        </button>
        <button type="button" className="btn btn-ghost" onClick={onAddGroup}>
          ＋ New item
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onWriteAll}
          disabled={usableGroups.length === 0}
        >
          ✍️ Write {usableGroups.length} listing
          {usableGroups.length === 1 ? "" : "s"}
        </button>
      </div>
    </section>
  );
}
