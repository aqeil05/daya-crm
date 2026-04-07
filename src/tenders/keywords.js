// ─── Tender Keyword Filter ─────────────────────────────────────────────────────
// Daya is a Qatar-based interior fit-out and design company.
// These keywords identify tenders that are likely relevant to bid on.

export const TENDER_KEYWORDS = [
  "fit out",
  "fitout",
  "fit-out",
  "interior",
  "interior design",
  "furniture",
  "carpentry",
  "joinery",
  "renovation",
  "refurbishment",
  "flooring",
  "ceiling",
  "partition",
  "gypsum",
  "curtain",
  "blinds",
  "joinery",
  "millwork",
  "fitout",
];

// Returns true if any keyword is found in the concatenated title + description.
// Case-insensitive substring match.
export function matchesKeywords(title = "", description = "") {
  const haystack = `${title} ${description}`.toLowerCase();
  return TENDER_KEYWORDS.some((kw) => haystack.includes(kw));
}
