# Zotero Literature

Objects of type `zotero` are Zotero library items referenced via `zotero://` URIs.

## How to identify

- Targets start with `zotero://` (e.g. `zotero://select/items/0_ABCDEFGH`)

## How to open

Use `lineup_open_object` — opens the item in the Zotero desktop app via the `zotero://` URI scheme.

## Tips

- Zotero items can be papers, books, conference proceedings, etc.
- The URI format is `zotero://select/items/<libraryID>_<itemKey>` for selecting an item
- To link a Zotero item to a lineup project, get the URI from Zotero (right-click → Copy Link) and use `lineup_link`
- For reading paper content, you'll need to access the attached PDF separately
