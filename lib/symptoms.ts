// A shared symptom gate, not a claim that the root cause has been proved.
export function uploadRegressionCandidate(text: string) {
  text = text.toLowerCase();
  const sizes = [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*mb/g)].map((m) =>
    Number(m[1]),
  );
  return (
    /upload|photo|image/.test(text) &&
    /413|file too large|fail|reject|can't|cannot|won't/.test(text) &&
    sizes.some((n) => n > 2 && n <= 5) &&
    !sizes.some((n) => n > 5) &&
    !/sideways|rotat|orientation|blurry|successfully/.test(text)
  );
}
