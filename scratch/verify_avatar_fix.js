function avatarColor(email) {
  const colors = ["#6366f1", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#14b8a6"];
  const safeEmail = String(email || "");
  if (!safeEmail) return colors[0];
  let h = 0;
  for (const c of safeEmail) {
    h = (h * 31 + c.charCodeAt(0)) % colors.length;
  }
  return colors[h];
}

console.log("Test with null:", avatarColor(null));
console.log("Test with undefined:", avatarColor(undefined));
console.log("Test with empty string:", avatarColor(""));
console.log("Test with email:", avatarColor("test@example.com"));
