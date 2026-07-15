export function canonicalBusinessLabel(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

export function canonicalIdentifier(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}
