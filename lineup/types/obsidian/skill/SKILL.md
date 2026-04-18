# Obsidian Notes

Objects of type `obsidian` are markdown files inside Obsidian vaults.

## How to identify

- Targets are filesystem paths (e.g. `/Users/x/Desktop/科研/科研笔记/note.md`)
- They live inside an Obsidian vault (a directory containing `.obsidian/`)
- Display path looks like `obsidian://VaultName/relative/path`

## How to open

Use `lineup_open_object` — the type system generates an `obsidian://open?vault=X&file=Y` URI that opens the note directly in the Obsidian app.

## How to read

Use `lineup_obsidian_read` (MCP tool) to read the note's markdown content. Or read the file directly at the target path.

## How to create

Use `lineup_new_file` with `app=obsidian` to create a new note in the vault.

## Tips

- Obsidian notes use `[[wikilinks]]` for internal links — these are not standard markdown
- Front matter (YAML between `---`) contains metadata
- If you need to search across notes, use `lineup_obsidian_search`
- To browse the vault hierarchy, use `lineup_obsidian_browse`
