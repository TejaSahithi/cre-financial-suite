// @ts-nocheck
function normalizeNumeric(value) {
  return String(value || "").replace(/[$,%]/g, "").toLowerCase();
}

export function checkForHallucination(answer, nodes) {
  const text = String(answer || "").toLowerCase();
  const supportedValues = (nodes || []).flatMap((node) => [node.value, ...(node.metadata?.aliases || [])]).filter((value) => value !== null && value !== undefined).map((value) => String(value).toLowerCase());
  const numericClaims = text.match(/\$?[0-9][0-9,]*(\.[0-9]+)?%?/g) || [];
  const unsupportedNumbers = numericClaims.filter((claim) => {
    const normalizedClaim = normalizeNumeric(claim);
    return !supportedValues.some((value) => {
      const normalizedValue = normalizeNumeric(value);
      return normalizedValue === normalizedClaim || normalizedValue.includes(normalizedClaim);
    });
  });
  return { passed: unsupportedNumbers.length === 0, unsupportedNumbers, reasonCodes: unsupportedNumbers.length ? ["unsupported_numeric_claim"] : ["answer_grounded"] };
}