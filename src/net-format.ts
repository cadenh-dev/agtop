export function formatIpv4(bytes: Uint8Array): string { return [...bytes].join("."); }
export function formatIpv6(bytes: Uint8Array): string {
  const words = Array.from({ length: 8 }, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16));
  if (words.slice(0, 5).every(word => word === "0") && words[5] === "ffff") return `::ffff:${formatIpv4(bytes.subarray(12, 16))}`;
  return words.join(":");
}

/** Format a socket endpoint without making IPv6 host and port ambiguous. */
export function formatEndpoint(address: string, port: number): string {
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}
