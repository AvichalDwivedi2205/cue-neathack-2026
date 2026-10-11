/* Caption-only search shared by the Bloom journal's browser adapter. */
(() => {
  window.BloomMemorySearch = Object.freeze({
    filterMemoriesByCaption(memories, query) {
      const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      if (!terms.length) return [...memories];

      return memories.filter((memory) => {
        const caption = memory.caption?.toLowerCase();
        return caption !== undefined && terms.every((term) => caption.includes(term));
      });
    },
  });
})();
