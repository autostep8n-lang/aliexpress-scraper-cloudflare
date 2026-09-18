export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function toDescriptionHtml(description: string | null | undefined): string {
  if (description == null || description === "") return "";
  return escapeHtml(description);
}
