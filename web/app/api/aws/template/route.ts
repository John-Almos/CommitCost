import { cloudFormationTemplate } from "@commitcost/platform";
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { platform } from "@/lib/platform";

export const dynamic = "force-dynamic";

/** The CloudFormation template, pre-filled with this workspace's external ID, as a download. */
export async function GET() {
  const ws = await requireOwner();
  const template = cloudFormationTemplate({ principalArn: platform().aws.principalArn, externalId: ws.org.awsExternalId });
  return new NextResponse(JSON.stringify(template, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="commitcost-aws-role.json"',
      "Cache-Control": "no-store",
    },
  });
}
