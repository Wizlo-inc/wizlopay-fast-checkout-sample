export interface Product {
  id: string;
  name: string;
  description: string;
  amount: number; // cents
  currency: string;
  emoji: string;
}

export const MAIN_PRODUCTS: Product[] = [
  { id: "p-headphones",    name: "Wireless Headphones",  description: "Premium ANC over-ear headphones",   amount: 4999, currency: "USD", emoji: "🎧" },
  { id: "p-smartwatch",    name: "Smart Watch",           description: "Health tracking & notifications",   amount: 7999, currency: "USD", emoji: "⌚" },
  { id: "p-speaker",       name: "Bluetooth Speaker",     description: "360° sound, waterproof design",    amount: 3999, currency: "USD", emoji: "🔊" },
  { id: "p-tracker",       name: "Fitness Tracker",       description: "Steps, sleep & heart rate",         amount: 5999, currency: "USD", emoji: "💪" },
  { id: "p-charger",       name: "Portable Charger",      description: "20,000 mAh fast charge power bank", amount: 2999, currency: "USD", emoji: "🔋" },
];

export const UPSELL_PRODUCTS: Product[] = [
  { id: "u-case",         name: "Premium Protective Case",  description: "Military-grade drop protection",    amount: 1999, currency: "USD", emoji: "🛡️" },
  { id: "u-warranty",     name: "2-Year Extended Warranty", description: "Full coverage, no questions asked", amount: 1499, currency: "USD", emoji: "✅" },
  { id: "u-screen",       name: "Screen Protector 3-Pack",  description: "Tempered glass, 9H hardness",       amount:  999, currency: "USD", emoji: "📱" },
  { id: "u-cleaning",     name: "Tech Cleaning Kit",        description: "Microfiber cloths + spray",         amount:  799, currency: "USD", emoji: "✨" },
];

export function findProduct(id: string, set: "main" | "upsell"): Product | undefined {
  const list = set === "main" ? MAIN_PRODUCTS : UPSELL_PRODUCTS;
  return list.find((p) => p.id === id);
}
