export async function randomDelay(): Promise<void> {
  const ms = Math.random() * 1000 + 3000; // 3000–4000ms
  await new Promise((resolve) => setTimeout(resolve, ms));
}
