export function parseGift(value) {
  if (value == null) return null;

  const validName = name =>
    typeof name === "string" &&
    name.trim().length >= 2 &&
    name.trim().length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(name);

  if (
    typeof value !== "object" ||
    !validName(value.recipientName) ||
    !["email", "share"].includes(value.delivery) ||
    typeof value.message !== "string" ||
    value.message.length > 500 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.message)
  ) {
    throw new Error("بيانات الهدية غير صحيحة");
  }

  const recipientEmail =
    typeof value.recipientEmail === "string"
      ? value.recipientEmail.trim()
      : "";

  if (
    value.delivery === "email" &&
    (
      recipientEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)
    )
  ) {
    throw new Error("بريد المهدى إليه غير صحيح");
  }

  return {
    recipientName: value.recipientName.trim(),
    message: value.message.trim(),
    delivery: value.delivery,
    recipientEmail:
      value.delivery === "email" ? recipientEmail : ""
  };
}
