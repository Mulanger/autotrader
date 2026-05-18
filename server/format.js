export function shortWallet(wallet = '') {
  if (!wallet || wallet.length < 12) return wallet || 'Unknown';
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function toUnixSeconds(value) {
  if (!value) return Math.floor(Date.now() / 1000);
  if (typeof value === 'number') return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
}
