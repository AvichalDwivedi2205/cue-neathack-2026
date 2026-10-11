export type CaptionSearchableMemory = {
  caption?: string | null;
};

/** Return memories whose captions contain every search term, ignoring case. */
export function filterMemoriesByCaption<T extends CaptionSearchableMemory>(
  memories: readonly T[],
  query: string,
): T[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...memories];

  return memories.filter((memory) => {
    const caption = memory.caption?.toLowerCase();
    return caption !== undefined && terms.every((term) => caption.includes(term));
  });
}
