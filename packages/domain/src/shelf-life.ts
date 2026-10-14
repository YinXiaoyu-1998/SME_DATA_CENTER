export type ShelfLifeEntry = { itemName: string; shelfLife: string };

export class ShelfLifeValidationError extends Error {}

/** Shared by operator imports and future authorized enterprise uploads. No normalization. */
export function parseShelfLifeEntries(input: unknown): ShelfLifeEntry[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 10000)
    throw new ShelfLifeValidationError(
      "Input must be an array of 1-10000 itemName/shelfLife pairs."
    );
  const values = new Map<string, string>();
  for (const entry of input) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.itemName !== "string" ||
      !entry.itemName.trim() ||
      entry.itemName.length > 512 ||
      typeof entry.shelfLife !== "string" ||
      !entry.shelfLife.trim() ||
      entry.shelfLife.length > 255 ||
      Object.keys(entry).some((key) => key !== "itemName" && key !== "shelfLife")
    )
      throw new ShelfLifeValidationError(
        "Each pair requires only nonempty itemName and shelfLife strings (max 512/255 characters)."
      );
    const previous = values.get(entry.itemName);
    if (previous !== undefined && previous !== entry.shelfLife)
      throw new ShelfLifeValidationError(
        "Input contains conflicting shelf lives for an identical item name."
      );
    values.set(entry.itemName, entry.shelfLife);
  }
  return [...values].map(([itemName, shelfLife]) => ({ itemName, shelfLife }));
}
