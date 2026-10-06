import type { Service } from "@commitcost/core";

export interface DataCall {
  services: Service[];
  kind: "sql" | "dynamodb" | "s3" | "http" | "lambda";
  label: string;
}

const PATTERNS: { re: RegExp; call: DataCall }[] = [
  {
    re: /\b(GetItemCommand|PutItemCommand|UpdateItemCommand|DeleteItemCommand|QueryCommand|ScanCommand|BatchGetItemCommand|GetCommand|PutCommand|UpdateCommand)\b|\bdynamo\w*\.(get|put|query|scan|update|send|get_item|put_item)\b|\bddb\w*\.(send|get|put|query|scan)\b|\.(getItem|putItem|updateItem|get_item|put_item)\s*\(/i,
    call: { services: ["DynamoDB"], kind: "dynamodb", label: "DynamoDB request" },
  },
  {
    re: /\b(GetObjectCommand|PutObjectCommand|HeadObjectCommand|CopyObjectCommand|ListObjectsV2Command)\b|\bs3\w*\.(getObject|putObject|upload|send|get_object|put_object|list_objects)\b/i,
    call: { services: ["S3"], kind: "s3", label: "S3 request" },
  },
  {
    re: /\b(InvokeCommand)\b|\blambda\w*\.invoke\b/i,
    call: { services: ["Lambda"], kind: "lambda", label: "Lambda invocation" },
  },
  {
    re: /\b(db|pool|client|conn|connection|knex|sequelize|prisma|tx|trx|orm|em|entityManager|cursor|session|sql)\b[\w.]*\.(query|execute|raw|find\w*|select|insert|update|delete|count|aggregate|first)\s*[(`]|\bSELECT\b[\s\S]*\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\.objects\.(get|filter|all)\(|\bprisma\.\w+\.\w+\(|\bRepository\.\w+\(|\brepo\w*\.(find\w*|get|query|load)\w*\(/i,
    call: { services: ["RDS"], kind: "sql", label: "database query" },
  },
  {
    re: /\bfetch\(|\baxios(\.\w+)?\(|\bgot\(|\bhttps?\.(get|request)\(|\brequests\.(get|post|put)\(|\bhttpx\.\w+\(/,
    call: { services: [], kind: "http", label: "HTTP request" },
  },
];

/** Classifies a line of code as a call to a billed backend, if it is one. */
export function classifyDataCall(text: string): DataCall | null {
  if (/^\s*(\/\/|#|\*)/.test(text)) return null;
  for (const p of PATTERNS) if (p.re.test(text)) return p.call;
  return null;
}
