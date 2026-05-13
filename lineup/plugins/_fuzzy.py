"""Alfred / VSCode-style fuzzy string matcher.

Used by the browse/search surfaces to match partial or non-contiguous
character sequences. Example: "fcs26" matches "FOCS26-paper221".

Scoring prioritises:
  1. Exact substring match (highest score, earlier position wins)
  2. Case-sensitive contiguous match
  3. Fuzzy non-contiguous match (smaller gaps → higher score)
"""

from __future__ import annotations


def fuzzy_score(query: str, candidate: str) -> int:
    """Return a match score, 0 meaning no match.

    Both arguments should already be lowercased by the caller.
    """
    if not query:
        return 1
    if not candidate:
        return 0

    # Exact substring match: big bonus, earlier position wins
    if query in candidate:
        pos = candidate.index(query)
        # Longer candidates get slightly lower scores (prefer tighter matches)
        return 1000 - pos - max(0, len(candidate) - len(query))

    # Fuzzy: every char of query must appear in candidate in order
    ci = 0
    last = -1
    total_gap = 0
    start = -1
    for qc in query:
        found = candidate.find(qc, ci)
        if found == -1:
            return 0
        if start == -1:
            start = found
        if last >= 0:
            total_gap += (found - last - 1)
        last = found
        ci = found + 1

    # Score = 300 base minus penalties
    # - gap between matching chars (tighter = better)
    # - starting position (earlier = better)
    return max(1, 300 - total_gap - start)
