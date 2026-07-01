"use client";

import type { ItemGroup, Photo } from "@/lib/types";

interface ReviewBoardProps {
  groups: ItemGroup[];
  orphanIds: string[];
  photoById: (id: string) => Photo | undefined;
  onRename: (groupId: string, name: string) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onMovePhoto: (photoId: string, toGroupId: string | "orphans") => void;
  onReorderPhoto: (groupId: string, photoId: string, toIndex: number) => void;
  onDeleteGroup: (groupId: string) => void;
  onAddGroup: () => void;
  onWriteAll: () => void;
  onBack: () => void;
}

let _dragData: { photoId: string; fromGroup: string | "orphans" } | null = null;

function clearDrag() {
  _dragData = null;
  document
    .querySelectorAll(".board-thumb.drag-source, .board-thumb.drag-over")
    .forEach((el) => el.classList.remove("drag-source", "drag-over"));
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
  onReorderPhoto,
}: {
  photoId: string;
  groupId: string | "orphans";
  groups: ItemGroup[];
  photoById: ReviewBoardProps["photoById"];
  onMovePhoto: ReviewBoardProps["onMovePhoto"];
  onReorderPhoto: ReviewBoardProps["onReorderPhoto"];
}) {
  const photo = photoById(photoId);
  if (!photo) return null;

  const handleDragStart = (e: React.DragEvent) => {
    _dragData = { photoId, fromGroup: groupId };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", photoId);
    e.currentTarget.classList.add("drag-source");
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    e.currentTarget.classList.add("drag-over");
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.currentTarget.classList.remove("drag-over");
  };

  const handleDragEnd = () => {
    clearDrag();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove("drag-over");

    const drag = _dragData;
    if (!drag || drag.photoId === photoId) {
      clearDrag();
      return;
    }

    const { photoId: draggedId, fromGroup } = drag;
    clearDrag();

    if (groupId === "orphans" || fromGroup === "orphans" || groupId !== fromGroup) {
      onMovePhoto(draggedId, groupId);
      return;
    }

    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const targetIndex = group.photoIds.indexOf(photoId);
    if (targetIndex === -1) return;
    onReorderPhoto(groupId, draggedId, targetIndex);
  };

  return (
    <figure
      className="board-thumb"
      draggable="true"
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDragEnd={handleDragEnd}
      onDrop={handleDrop}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.previewUrl} alt="Item photo" draggable={false} />
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
  onRenameSku,
  onMovePhoto,
  onReorderPhoto,
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
        Check the groupings below. Drag photos to reorder, or use the menu
        under any photo to move it to the right item. Then write all the
        listings at once.
      </p>

      <div className="board">
        {groups.map((group) => (
          <article className="board-item" key={group.id}>
            <header className="board-item-head">
              <input
                type="text"
                className="board-sku"
                value={group.sku}
                aria-label="Item SKU / bin code"
                placeholder="SKU"
                onChange={(e) => onRenameSku(group.id, e.target.value)}
              />
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
                Empty — drag photos here or use the menu under a photo.
              </p>
            ) : (
              <div
                className="board-thumbs"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const drag = _dragData;
                  if (!drag) return;
                  const { photoId, fromGroup } = drag;
                  clearDrag();
                  if (group.id !== fromGroup) {
                    onMovePhoto(photoId, group.id);
                  }
                }}
              >
                {group.photoIds.map((pid) => (
                  <Thumb
                    key={pid}
                    photoId={pid}
                    groupId={group.id}
                    groups={groups}
                    photoById={photoById}
                    onMovePhoto={onMovePhoto}
                    onReorderPhoto={onReorderPhoto}
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
          <div
            className="board-thumbs"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              e.preventDefault();
              const drag = _dragData;
              if (!drag) return;
              const { photoId, fromGroup } = drag;
              clearDrag();
              if ("orphans" !== fromGroup) {
                onMovePhoto(photoId, "orphans");
              }
            }}
          >
            {orphanIds.map((pid) => (
              <Thumb
                key={pid}
                photoId={pid}
                groupId="orphans"
                groups={groups}
                photoById={photoById}
                onMovePhoto={onMovePhoto}
                onReorderPhoto={onReorderPhoto}
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
