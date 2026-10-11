// Conservative source gate shared by the trusted model gateway and durable mutations.
export function sourcePolicy(text: string) {
  return {
    unsupported:
      /\b(pdf|export\w*|sync\w*|collaborat\w*|shared albums?)\b/i.test(text),
    promotional:
      /\b(?:buy|try|use|join|subscribe to|sign up for)\s+(?:my|our)\b|\b(?:affiliate|sponsored|subscribe now)\b/i.test(
        text,
      ),
    explicit:
      /\b(anyone|recommend\w*|looking for|is there|suggest\w*|help me|any app|app.*(?:find|search)|need.*(?:find|search))\b/i.test(
        text,
      ),
    matched:
      /\b(search\w*|find|finding)\b/i.test(text) &&
      /\b(journal\w*|memor\w*|photo\w*|diary|written|wrote)\b/i.test(text),
  };
}

// Applied to human edits and model drafts before exact-version review.
export function growthDraftSupported(text: string, link: string) {
  const urls = (text.match(/https?:\/\/[^\s)]+/g) || []).map((url) =>
    url.replace(/[.,!?]+$/, ""),
  );
  return (
    !!text.trim() &&
    text.length <= 280 &&
    text.split(link).length === 2 &&
    urls.length === 1 &&
    urls[0] === link &&
    !/\b(pdf|export\w*|sync\w*|collaborat\w*|shared albums?|guarantee\w*|free|unlimited|account|pricing)\b/i.test(
      text,
    ) &&
    !/\b(?:any|one|either)\s+(?:query\s+)?words?\b/i.test(text)
  );
}
