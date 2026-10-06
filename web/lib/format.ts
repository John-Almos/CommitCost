export function usd(n: number, opts: { sign?: boolean; cents?: boolean } = {}): string {
  const abs = Math.abs(n);
  const body =
    abs >= 10_000 && !opts.cents
      ? `${(abs / 1000).toFixed(abs >= 100_000 ? 0 : 1)}K`
      : abs.toLocaleString("en-US", { minimumFractionDigits: opts.cents ? 2 : 0, maximumFractionDigits: opts.cents ? 2 : 0 });
  const sign = n < 0 ? "−" : opts.sign ? "+" : "";
  return `${sign}$${body}`;
}

export function usdFull(n: number, sign = false): string {
  return `${n < 0 ? "−" : sign ? "+" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export function fmtDate(iso: string, withYear = false): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: withYear ? "numeric" : undefined, timeZone: "UTC" });
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export const SERVICE_NAMES: Record<string, string> = {
  EC2: "EC2",
  RDS: "RDS",
  Lambda: "Lambda",
  S3: "S3",
  DynamoDB: "DynamoDB",
  DataTransfer: "Data transfer",
  Other: "Other",
};
