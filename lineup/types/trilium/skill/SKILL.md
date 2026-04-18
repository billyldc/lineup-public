# Trilium Notes

Objects of type `trilium` are notes stored in the Trilium Notes local database.

## How to identify

- Targets are Trilium note IDs: short alphanumeric strings like `DPS7i6SnoUwy`
- Display path looks like `trilium://Grandparent/Parent/NoteName`

## How to open

Use `lineup_open_object` — the type system uses AppleScript to focus the note's tab in the TriliumNext desktop app (or opens a new tab via search if it's not already open).

## How to read

Use `lineup_trilium_read` (MCP tool) with the note ID to get the note's content as plain text.

## Tips

- Trilium stores notes as HTML internally; the read function strips tags for you
- Notes can be of type `text`, `code`, or other — only text and code can be read as text
- Trilium has a tree structure (notes inside notes) — use `lineup_trilium_browse` to navigate
- Search across all notes with `lineup_trilium_search`
