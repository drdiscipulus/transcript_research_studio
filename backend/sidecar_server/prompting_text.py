from __future__ import annotations

import string


def normalize_match_text(value: str) -> str:
    translator = str.maketrans({character: " " for character in string.punctuation + "“”‘’„…"})
    return " ".join(value.lower().translate(translator).split())


def verify_quote(quote: str, full_text: str) -> str:
    """Classify whether a proposed quote can be found verbatim or near-verbatim in source text."""
    normalized_quote = normalize_match_text(quote)
    normalized_full_text = normalize_match_text(full_text)
    if not normalized_quote:
        return "not_verified"
    if normalized_quote in normalized_full_text:
        return "verified"
    quote_tokens = normalized_quote.split()
    if len(quote_tokens) < 5:
        return "not_verified"
    window_size = len(quote_tokens)
    full_tokens = normalized_full_text.split()
    best_overlap = 0
    for index in range(0, max(1, len(full_tokens) - window_size + 1)):
        window = full_tokens[index : index + window_size]
        overlap = len(set(quote_tokens) & set(window))
        if overlap > best_overlap:
            best_overlap = overlap
    return "verified" if best_overlap / max(1, len(set(quote_tokens))) >= 0.85 else "not_verified"
