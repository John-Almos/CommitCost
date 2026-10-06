import type { GetProductsCommand } from "@aws-sdk/client-pricing";
import { describe, expect, it } from "vitest";
import { AwsPriceList, type PricingLike } from "./priceList.js";

const item = (attributes: Record<string, string>, dims: { unit: string; beginRange?: string; usd: string }[]) =>
  JSON.stringify({
    product: { attributes },
    publicationDate: "2026-10-01T00:00:00Z",
    terms: { OnDemand: { t: { priceDimensions: Object.fromEntries(dims.map((d, i) => [String(i), { unit: d.unit, beginRange: d.beginRange, pricePerUnit: { USD: d.usd } }])) } } },
  });

describe("AwsPriceList", () => {
  it("turns GetProducts results into the same price book as the bundled snapshot", async () => {
    const calls: GetProductsCommand["input"][] = [];
    const client: PricingLike = {
      async send(command) {
        calls.push(command.input);
        const list =
          command.input.ServiceCode === "AmazonEC2" && command.input.Filters!.some((f) => f.Field === "operatingSystem")
            ? [
                item({ usagetype: "USW2-BoxUsage:m5.large", operation: "RunInstances", operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used" }, [{ unit: "Hrs", usd: "0.0960000000" }]),
                item({ usagetype: "USW2-BoxUsage:m5.large", operation: "RunInstances:0002", operatingSystem: "Windows", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used" }, [{ unit: "Hrs", usd: "0.188" }]),
              ]
            : command.input.ServiceCode === "AWSDataTransfer"
              ? [item({ usagetype: "USW2-DataTransfer-Out-Bytes" }, [{ unit: "GB", beginRange: "0", usd: "0.09" }, { unit: "GB", beginRange: "10240", usd: "0.085" }])]
              : [];
        return { $metadata: {}, PriceList: list };
      },
    };
    const book = await new AwsPriceList({ client, today: () => "2026-10-06" }).priceBook(["us-west-2"]);
    expect(calls.every((c) => c.Filters!.some((f) => f.Field === "regionCode" && f.Value === "us-west-2"))).toBe(true);
    expect(book.price("us-west-2", "AmazonEC2", "BoxUsage:m5.large")).toMatchObject({ unit: "Hrs", tiers: [{ fromUnits: 0, usdPerUnit: 0.096 }], source: "price-list-api", asOf: "2026-10-01" });
    expect(book.price("us-west-2", "AWSDataTransfer", "DataTransfer-Out-Bytes")?.tiers).toEqual([
      { fromUnits: 0, usdPerUnit: 0.09 },
      { fromUnits: 10240, usdPerUnit: 0.085 },
    ]);
  });
});
